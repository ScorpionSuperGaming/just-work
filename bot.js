const {
  Client, GatewayIntentBits, SlashCommandBuilder,
  PermissionFlagsBits, ChannelType, ActionRowBuilder,
  ButtonBuilder, ButtonStyle, EmbedBuilder,
  ModalBuilder, TextInputBuilder, TextInputStyle,
  Events
} = require('discord.js');
const { REST } = require('@discordjs/rest');
const { Routes } = require('discord-api-types/v10');
const axios = require('axios');

// ── CONFIG ────────────────────────────────────────────────────────────────────
const BOT_TOKEN       = process.env.BOT_TOKEN;
const CLIENT_ID       = process.env.CLIENT_ID;
const BLOCKCYPHER_KEY = process.env.BLOCKCYPHER_KEY;
const ADMIN_ROLE_ID   = process.env.ADMIN_ROLE_ID;
const FEE_PERCENT     = parseFloat(process.env.FEE_PERCENT || '1');

// ── THEME ─────────────────────────────────────────────────────────────────────
const COLORS = {
  primary:  0x00FF41,
  success:  0x00FF41,
  warning:  0xFFD700,
  danger:   0xFF3131,
  blue:     0x3498DB,
};
const DIVIDER = '▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬';

// ── TRADE STORE ───────────────────────────────────────────────────────────────
const trades = {};

// ── CLIENT ────────────────────────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ],
});

// ── COMMANDS ──────────────────────────────────────────────────────────────────
const commands = [
  new SlashCommandBuilder()
    .setName('setup')
    .setDescription('Post the Imu Escrow panel in this channel')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
];

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(BOT_TOKEN);
  try {
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands.map(c => c.toJSON()) });
    console.log('✅ Slash commands registered');
  } catch (e) { console.error('Failed to register commands:', e); }
}

// ── HELPERS ───────────────────────────────────────────────────────────────────
function generateTradeId() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

async function getLTCPrice() {
  const res = await axios.get('https://api.coingecko.com/api/v3/simple/price?ids=litecoin&vs_currencies=usd');
  return res.data.litecoin.usd;
}

async function generateLTCAddress() {
  const res = await axios.post(`https://api.blockcypher.com/v1/ltc/main/addrs?token=${BLOCKCYPHER_KEY}`);
  return { address: res.data.address, privateKey: res.data.private };
}

async function getLTCBalance(address) {
  const res = await axios.get(`https://api.blockcypher.com/v1/ltc/main/addrs/${address}/balance?token=${BLOCKCYPHER_KEY}`);
  return res.data.balance / 1e8;
}

async function sendLTC(fromPrivateKey, fromAddress, toAddress, amountLTC) {
  const satoshis = Math.floor(amountLTC * 1e8);
  const feeSatoshis = 10000;
  const newTx = {
    inputs: [{ addresses: [fromAddress] }],
    outputs: [{ addresses: [toAddress], value: satoshis - feeSatoshis }],
  };
  const txRes = await axios.post(`https://api.blockcypher.com/v1/ltc/main/txs/new?token=${BLOCKCYPHER_KEY}`, newTx);
  const tmptx = txRes.data;
  const EC = require('elliptic').ec;
  const ec = new EC('secp256k1');
  const key = ec.keyFromPrivate(fromPrivateKey, 'hex');
  tmptx.pubkeys = [];
  tmptx.signatures = tmptx.tosign.map((tosign) => {
    tmptx.pubkeys.push(key.getPublic('hex'));
    return key.sign(tosign).toDER('hex');
  });
  const sendRes = await axios.post(`https://api.blockcypher.com/v1/ltc/main/txs/send?token=${BLOCKCYPHER_KEY}`, tmptx);
  return sendRes.data.tx.hash;
}

async function resolveUser(guild, input) {
  input = input.trim();
  const mentionMatch = input.match(/^<@!?(\d+)>$/);
  if (mentionMatch) return guild.members.fetch(mentionMatch[1]).catch(() => null);
  if (/^\d{15,20}$/.test(input)) return guild.members.fetch(input).catch(() => null);
  const members = await guild.members.fetch({ query: input, limit: 1 }).catch(() => null);
  if (members && members.size > 0) return members.first();
  return null;
}

// ── WATCH FOR PAYMENT ─────────────────────────────────────────────────────────
async function watchForPayment(tradeId) {
  const trade = trades[tradeId];
  const maxAttempts = 120;
  let attempts = 0;
  const interval = setInterval(async () => {
    attempts++;
    if (attempts > maxAttempts || trade.status !== 'awaiting_payment') {
      clearInterval(interval);
      if (trade.status === 'awaiting_payment') {
        const ch = await client.channels.fetch(trade.channelId).catch(() => null);
        if (ch) await ch.send({
          embeds: [new EmbedBuilder().setColor(COLORS.danger).setTitle('◈  TRADE EXPIRED  ⏰')
            .setDescription('```\n  No payment received within 1 hour.\n  This trade has been cancelled.\n```')
            .setFooter({ text: `◈ Imu Escrow  •  Trade #ltc-${tradeId}` })]
        });
        trade.status = 'expired';
      }
      return;
    }
    try {
      const balance = await getLTCBalance(trade.address);
      if (balance >= trade.ltcAmount) {
        clearInterval(interval);
        trade.status = 'funded';
        const ch = await client.channels.fetch(trade.channelId).catch(() => null);
        if (!ch) return;

        const fee = (trade.ltcAmount * FEE_PERCENT / 100).toFixed(6);
        const receiverGets = (trade.ltcAmount - parseFloat(fee)).toFixed(6);

        const embed = new EmbedBuilder()
          .setColor(COLORS.success)
          .setTitle('◈  PAYMENT CONFIRMED  ✅')
          .setDescription(
            '```\n  Funds Secured in Escrow\n```\n' + DIVIDER + '\n\n' +
            `> ✅  **${trade.ltcAmount} LTC** received on-chain\n` +
            `> 🟢  **Sender:** <@${trade.senderId}>\n` +
            `> 🔵  **Receiver:** <@${trade.receiverId}>\n\n` + DIVIDER
          )
          .addFields(
            { name: '💸  READY TO RELEASE', value: `\`\`\`${receiverGets} LTC → Receiver\`\`\`` },
            { name: '\u200b', value: DIVIDER + '\n' + `<@${trade.senderId}> — Press **Release Funds** when satisfied.\nIf there is an issue, press **Open Dispute**.` },
          )
          .setFooter({ text: `◈ Imu Escrow  •  Trade #ltc-${tradeId}` })
          .setTimestamp();

        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`release_${tradeId}`).setLabel('✅  Release Funds').setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId(`dispute_${tradeId}`).setLabel('⚠️  Open Dispute').setStyle(ButtonStyle.Danger),
        );
        await ch.send({ content: `<@${trade.senderId}> <@${trade.receiverId}>`, embeds: [embed], components: [row] });
      }
    } catch (e) { console.error('Balance check error:', e.message); }
  }, 30000);
}

// ── READY ─────────────────────────────────────────────────────────────────────
client.once('ready', async () => {
  console.log(`✅ Imu Escrow online as ${client.user.tag}`);
  await registerCommands();
});

// ── INTERACTIONS ──────────────────────────────────────────────────────────────
client.on(Events.InteractionCreate, async interaction => {

  // /setup
  if (interaction.isChatInputCommand() && interaction.commandName === 'setup') {
    const embed = new EmbedBuilder()
      .setColor(COLORS.primary)
      .setTitle('◈  I M U  E S C R O W')
      .setDescription(
        '```\n  Premium Litecoin Escrow Service\n```\n' + DIVIDER + '\n\n' +
        '> 🔐  **Unique LTC address generated per trade**\n' +
        '> ⚡  **Live USDT → LTC conversion**\n' +
        '> 💸  **Funds released directly to receiver\'s wallet**\n' +
        '> 🔒  **Private tickets — only you & your trader**\n\n' +
        DIVIDER + '\n\n' +
        '**How it works:**\n' +
        '`①` Click **Open Trade** & fill in trader info\n' +
        '`②` Select your role in the private ticket\n' +
        '`③` Sender enters USDT amount → bot converts to LTC\n' +
        '`④` Both confirm the amount\n' +
        '`⑤` Send LTC → bot confirms → funds released automatically'
      )
      .setFooter({ text: '◈ Imu Escrow  •  Secure  •  Automated  •  Trusted' })
      .setTimestamp();
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('new_trade').setLabel('◈  Open Trade').setStyle(ButtonStyle.Success),
    );
    await interaction.channel.send({ embeds: [embed], components: [row] });
    await interaction.reply({ content: '✅ Escrow panel posted!', ephemeral: true });
    return;
  }

  // Open Trade → modal (3 fields only)
  if (interaction.isButton() && interaction.customId === 'new_trade') {
    const modal = new ModalBuilder().setCustomId('trade_form').setTitle('◈ Imu Escrow — New Trade');
    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('trader_id').setLabel('Trader\'s User ID').setPlaceholder('e.g. 123456789012345678').setStyle(TextInputStyle.Short).setRequired(true)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('you_giving').setLabel('What are YOU giving?').setPlaceholder('e.g. 0.5 LTC').setStyle(TextInputStyle.Short).setRequired(true)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('they_giving').setLabel('What are THEY giving?').setPlaceholder('e.g. 50 USDT').setStyle(TextInputStyle.Short).setRequired(true)
      ),
    );
    await interaction.showModal(modal);
    return;
  }

  // Modal submitted
  if (interaction.isModalSubmit() && interaction.customId === 'trade_form') {
    await interaction.deferReply({ ephemeral: true });
    const traderId   = interaction.fields.getTextInputValue('trader_id');
    const youGiving  = interaction.fields.getTextInputValue('you_giving');
    const theyGiving = interaction.fields.getTextInputValue('they_giving');

    const traderMember = await resolveUser(interaction.guild, traderId);
    if (!traderMember) return interaction.editReply({ content: `❌ Could not find user **${traderId}**. Make sure they are in the server.` });
    if (traderMember.id === interaction.user.id) return interaction.editReply({ content: '❌ You cannot trade with yourself.' });

    const tradeId = generateTradeId();
    const creator = interaction.user;
    const trader  = traderMember.user;

    const channel = await interaction.guild.channels.create({
      name: `ltc-${tradeId}`,
      type: ChannelType.GuildText,
      permissionOverwrites: [
        { id: interaction.guild.roles.everyone, deny: [PermissionFlagsBits.ViewChannel] },
        { id: creator.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
        { id: trader.id,  allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
        { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ReadMessageHistory] },
      ],
    });

    trades[tradeId] = {
      channelId: channel.id,
      creatorId: creator.id,
      traderId: trader.id,
      senderId: null,
      receiverId: null,
      youGiving, theyGiving,
      usdtAmount: null,
      ltcAmount: null,
      ltcPrice: null,
      address: null,
      privateKey: null,
      status: 'selecting_roles',
      funded: false,
      senderConfirmedAmount: false,
      receiverConfirmedAmount: false,
    };

    const embed = new EmbedBuilder()
      .setColor(COLORS.primary)
      .setTitle(`◈  TRADE  #ltc-${tradeId}`)
      .setDescription(
        '```\n  New Escrow Session Initialized\n```\n' + DIVIDER + '\n\n' +
        `> 👤  **Trader 1:** <@${creator.id}>\n` +
        `> 👤  **Trader 2:** <@${trader.id}>\n\n` + DIVIDER
      )
      .addFields(
        { name: '📦  TRADE DETAILS', value: `> <@${creator.id}> is giving **${youGiving}**\n> <@${trader.id}> is giving **${theyGiving}**` },
        { name: '\u200b', value: DIVIDER + '\n**Both parties must select their role below to begin.**\n\n🟢  `I am Sending` — You will send LTC\n🔵  `I am Receiving` — You will receive LTC' },
      )
      .setFooter({ text: `◈ Imu Escrow  •  Trade ID: ltc-${tradeId}  •  ${new Date().toUTCString()}` });

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`role_sender_${tradeId}`).setLabel('🟢  I am Sending LTC').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`role_receiver_${tradeId}`).setLabel('🔵  I am Receiving LTC').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`cancel_${tradeId}`).setLabel('✖  Cancel Trade').setStyle(ButtonStyle.Danger),
    );

    await channel.send({ content: `<@${creator.id}> <@${trader.id}>`, embeds: [embed], components: [row] });
    await interaction.editReply({ content: `✅ Trade ticket opened: ${channel}` });
    return;
  }

  // Role selection
  if (interaction.isButton() && interaction.customId.startsWith('role_')) {
    const parts = interaction.customId.split('_');
    const role = parts[1];
    const tradeId = parts[2];
    const trade = trades[tradeId];
    if (!trade) return interaction.reply({ content: '❌ Trade not found.', ephemeral: true });
    if (trade.status !== 'selecting_roles') return interaction.reply({ content: '❌ Roles already locked.', ephemeral: true });

    const userId = interaction.user.id;
    if (userId !== trade.creatorId && userId !== trade.traderId) return interaction.reply({ content: '❌ You are not part of this trade.', ephemeral: true });
    if (role === 'sender') {
      if (trade.senderId === userId) return interaction.reply({ content: '❌ You already claimed Sender.', ephemeral: true });
      if (trade.receiverId === userId) return interaction.reply({ content: '❌ You already claimed Receiver.', ephemeral: true });
      trade.senderId = userId;
    }
    if (role === 'receiver') {
      if (trade.receiverId === userId) return interaction.reply({ content: '❌ You already claimed Receiver.', ephemeral: true });
      if (trade.senderId === userId) return interaction.reply({ content: '❌ You already claimed Sender.', ephemeral: true });
      trade.receiverId = userId;
    }

    await interaction.reply({
      embeds: [new EmbedBuilder().setColor(role === 'sender' ? COLORS.success : COLORS.blue)
        .setDescription(`> ${role === 'sender' ? '🟢' : '🔵'}  <@${userId}> claimed the **${role === 'sender' ? 'Sender' : 'Receiver'}** role.`)]
    });

    if (trade.senderId && trade.receiverId) {
      trade.status = 'awaiting_amount';
      await interaction.channel.send({
        embeds: [new EmbedBuilder().setColor(COLORS.warning)
          .setTitle('◈  ENTER TRADE AMOUNT')
          .setDescription(
            '```\n  Roles Confirmed — Amount Required\n```\n' + DIVIDER + '\n\n' +
            `> 🟢  **Sender:** <@${trade.senderId}>\n` +
            `> 🔵  **Receiver:** <@${trade.receiverId}>\n\n` + DIVIDER + '\n\n' +
            `<@${trade.senderId}> — Please type the **amount in USDT** you are sending.\n\n` +
            '> Example: `50` or `125.50`'
          )
          .setFooter({ text: `◈ Imu Escrow  •  Trade #ltc-${tradeId}` })]
      });
    }
    return;
  }

  // Confirm amount button
  if (interaction.isButton() && interaction.customId.startsWith('confirmamt_')) {
    const tradeId = interaction.customId.split('_')[1];
    const trade = trades[tradeId];
    if (!trade) return interaction.reply({ content: '❌ Trade not found.', ephemeral: true });
    if (trade.status !== 'confirming_amount') return interaction.reply({ content: '❌ Nothing to confirm yet.', ephemeral: true });

    const userId = interaction.user.id;
    if (userId !== trade.senderId && userId !== trade.receiverId) return interaction.reply({ content: '❌ You are not part of this trade.', ephemeral: true });

    if (userId === trade.senderId) trade.senderConfirmedAmount = true;
    if (userId === trade.receiverId) trade.receiverConfirmedAmount = true;

    await interaction.reply({
      embeds: [new EmbedBuilder().setColor(COLORS.success)
        .setDescription(`> ✅  **${userId === trade.senderId ? 'Sender' : 'Receiver'}** confirmed the amount.`)]
    });

    // Both confirmed → generate address
    if (trade.senderConfirmedAmount && trade.receiverConfirmedAmount) {
      trade.status = 'generating_address';
      const loadingMsg = await interaction.channel.send({
        embeds: [new EmbedBuilder().setColor(COLORS.primary).setDescription('```\n  ⚡ Both confirmed! Generating unique LTC address...\n```')]
      });

      try {
        const wallet = await generateLTCAddress();
        trade.address = wallet.address;
        trade.privateKey = wallet.privateKey;
        trade.status = 'awaiting_payment';
        await loadingMsg.delete().catch(() => {});

        const fee = (trade.ltcAmount * FEE_PERCENT / 100).toFixed(6);
        const receiverGets = (trade.ltcAmount - parseFloat(fee)).toFixed(6);

        const payEmbed = new EmbedBuilder()
          .setColor(COLORS.warning)
          .setTitle('◈  SEND PAYMENT')
          .setDescription(
            '```\n  Address Generated — Awaiting Payment\n```\n' + DIVIDER + '\n\n' +
            `> 🟢  **Sender:** <@${trade.senderId}>\n` +
            `> 🔵  **Receiver:** <@${trade.receiverId}>\n\n` + DIVIDER
          )
          .addFields(
            { name: '💵  USDT AMOUNT', value: `\`\`\`$${trade.usdtAmount} USDT\`\`\``, inline: true },
            { name: '💎  LTC EQUIVALENT', value: `\`\`\`${trade.ltcAmount} LTC\`\`\``, inline: true },
            { name: '📋  LTC PRICE USED', value: `\`\`\`$${trade.ltcPrice} / LTC\`\`\``, inline: true },
            { name: '🏦  SEND LTC TO THIS ADDRESS', value: `\`\`\`${wallet.address}\`\`\`` },
            { name: '🤝  RECEIVER GETS', value: `\`${receiverGets} LTC\``, inline: true },
            { name: '📋  FEE', value: `\`${fee} LTC (${FEE_PERCENT}%)\``, inline: true },
            { name: '\u200b', value: DIVIDER + '\n⚠️  Send **exactly** `' + trade.ltcAmount + ' LTC`\n🔄  Bot checks every **30 seconds**\n⏰  Expires after **1 hour**' },
          )
          .setFooter({ text: `◈ Imu Escrow  •  Trade #ltc-${tradeId}` });

        const copyRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`copydetails_${tradeId}`).setLabel('📋  Copy Details').setStyle(ButtonStyle.Secondary),
        );

        await interaction.channel.send({
          content: `<@${trade.senderId}> <@${trade.receiverId}>`,
          embeds: [payEmbed],
          components: [copyRow],
        });

        watchForPayment(tradeId);
      } catch (e) {
        trade.status = 'confirming_amount';
        await loadingMsg.delete().catch(() => {});
        await interaction.channel.send('❌ Failed to generate LTC address. Please try again.');
      }
    }
    return;
  }

  // Copy Details button → sends 2 separate messages
  if (interaction.isButton() && interaction.customId.startsWith('copydetails_')) {
    const tradeId = interaction.customId.split('_')[1];
    const trade = trades[tradeId];
    if (!trade) return interaction.reply({ content: '❌ Trade not found.', ephemeral: true });

    await interaction.reply({ content: '📋 Details sent below!', ephemeral: true });
    await interaction.channel.send(`\`\`\`${trade.address}\`\`\``);
    await interaction.channel.send(`\`\`\`${trade.ltcAmount}\`\`\``);
    return;
  }

  // Release funds
  if (interaction.isButton() && interaction.customId.startsWith('release_')) {
    const tradeId = interaction.customId.split('_')[1];
    const trade = trades[tradeId];
    if (!trade) return interaction.reply({ content: '❌ Trade not found.', ephemeral: true });
    if (interaction.user.id !== trade.senderId) return interaction.reply({ content: '❌ Only the Sender can release funds.', ephemeral: true });
    if (trade.status !== 'funded') return interaction.reply({ content: '❌ Funds not confirmed yet.', ephemeral: true });
    trade.status = 'awaiting_receiver_address';
    await interaction.reply({
      embeds: [new EmbedBuilder().setColor(COLORS.primary).setTitle('◈  FUNDS RELEASED')
        .setDescription(
          '```\n  Sender Approved — Enter Wallet Address\n```\n' + DIVIDER + '\n\n' +
          `<@${trade.receiverId}> — Please type your **LTC wallet address** to receive your funds.`
        )
        .setFooter({ text: `◈ Imu Escrow  •  Trade #ltc-${tradeId}` })]
    });
    return;
  }

  // Dispute
  if (interaction.isButton() && interaction.customId.startsWith('dispute_')) {
    const tradeId = interaction.customId.split('_')[1];
    const trade = trades[tradeId];
    if (!trade) return interaction.reply({ content: '❌ Trade not found.', ephemeral: true });
    if (interaction.user.id !== trade.senderId && interaction.user.id !== trade.receiverId) return interaction.reply({ content: '❌ You are not part of this trade.', ephemeral: true });
    trade.status = 'disputed';
    const adminPing = ADMIN_ROLE_ID ? `<@&${ADMIN_ROLE_ID}>` : '@Admin';
    await interaction.reply({
      embeds: [new EmbedBuilder().setColor(COLORS.danger).setTitle('◈  DISPUTE OPENED  ⚠️')
        .setDescription('```\n  Admin Review Required\n```\n' + DIVIDER + '\n\n' +
          `> Raised by <@${interaction.user.id}>\n> ${adminPing} please review.\n\n` + DIVIDER)
        .setFooter({ text: `◈ Imu Escrow  •  Trade #ltc-${tradeId}` }).setTimestamp()]
    });
    return;
  }

  // Cancel
  if (interaction.isButton() && interaction.customId.startsWith('cancel_')) {
    const tradeId = interaction.customId.split('_')[1];
    const trade = trades[tradeId];
    if (!trade) return interaction.reply({ content: '❌ Trade not found.', ephemeral: true });
    if (trade.funded) return interaction.reply({ content: '❌ Cannot cancel — funds already received.', ephemeral: true });
    if (interaction.user.id !== trade.creatorId && interaction.user.id !== trade.traderId) return interaction.reply({ content: '❌ You are not part of this trade.', ephemeral: true });
    trade.status = 'cancelled';
    await interaction.reply({
      embeds: [new EmbedBuilder().setColor(COLORS.danger).setTitle('◈  TRADE CANCELLED')
        .setDescription('```\n  This trade has been cancelled.\n  Channel deletes in 5 seconds.\n```')
        .setFooter({ text: `◈ Imu Escrow  •  Trade #ltc-${tradeId}` })]
    });
    setTimeout(async () => { await interaction.channel.delete().catch(() => {}); }, 5000);
    return;
  }

  // Close ticket
  if (interaction.isButton() && interaction.customId.startsWith('close_')) {
    await interaction.reply({
      embeds: [new EmbedBuilder().setColor(COLORS.primary).setDescription('```\n  🔒 Archiving ticket in 5 seconds...\n```')]
    });
    setTimeout(async () => { await interaction.channel.delete().catch(() => {}); }, 5000);
    return;
  }
});

// ── MESSAGE HANDLER ───────────────────────────────────────────────────────────
client.on(Events.MessageCreate, async message => {
  if (message.author.bot) return;
  const trade = Object.entries(trades).find(([, t]) => t.channelId === message.channel.id);
  if (!trade) return;
  const [tradeId, tradeData] = trade;

  // Sender enters USDT amount
  if (tradeData.status === 'awaiting_amount' && message.author.id === tradeData.senderId) {
    const usdt = parseFloat(message.content.trim());
    if (isNaN(usdt) || usdt <= 0) {
      await message.reply({ embeds: [new EmbedBuilder().setColor(COLORS.danger).setDescription('> ❌  Invalid amount. Type a number like `50` or `125.50`')] });
      return;
    }

    const loadingMsg = await message.channel.send({
      embeds: [new EmbedBuilder().setColor(COLORS.primary).setDescription('```\n  ⚡ Fetching live LTC price...\n```')]
    });

    try {
      const ltcPrice = await getLTCPrice();
      const ltcAmount = parseFloat((usdt / ltcPrice).toFixed(6));
      tradeData.usdtAmount = usdt;
      tradeData.ltcAmount = ltcAmount;
      tradeData.ltcPrice = ltcPrice;
      tradeData.status = 'confirming_amount';
      tradeData.senderConfirmedAmount = false;
      tradeData.receiverConfirmedAmount = false;

      await loadingMsg.delete().catch(() => {});

      const amountEmbed = new EmbedBuilder()
        .setColor(COLORS.warning)
        .setTitle('◈  AMOUNT SET')
        .setDescription(
          '```\n  The Sender Has Set the Trade Amount\n```\n' + DIVIDER + '\n\n' +
          `> 🟢  **Sender:** <@${tradeData.senderId}> has put the amount\n\n` + DIVIDER
        )
        .addFields(
          { name: '💵  USDT AMOUNT', value: `\`\`\`$${usdt} USDT\`\`\``, inline: true },
          { name: '💎  LTC EQUIVALENT', value: `\`\`\`${ltcAmount} LTC\`\`\``, inline: true },
          { name: '📈  LIVE LTC PRICE', value: `\`\`\`$${ltcPrice} / LTC\`\`\``, inline: true },
          { name: '\u200b', value: DIVIDER + '\n**Both parties must confirm this amount to proceed.**' },
        )
        .setFooter({ text: `◈ Imu Escrow  •  Trade #ltc-${tradeId}` });

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`confirmamt_${tradeId}`).setLabel('✅  Confirm Amount').setStyle(ButtonStyle.Success),
      );

      await message.channel.send({
        content: `<@${tradeData.senderId}> <@${tradeData.receiverId}>`,
        embeds: [amountEmbed],
        components: [row],
      });
    } catch (e) {
      tradeData.status = 'awaiting_amount';
      await loadingMsg.delete().catch(() => {});
      await message.channel.send({ embeds: [new EmbedBuilder().setColor(COLORS.danger).setDescription('> ❌  Failed to fetch LTC price. Please try again.')] });
    }
    return;
  }

  // Receiver enters LTC wallet address
  if (tradeData.status === 'awaiting_receiver_address' && message.author.id === tradeData.receiverId) {
    const receiverAddress = message.content.trim();
    if (!receiverAddress.match(/^[LM3][a-km-zA-HJ-NP-Z1-9]{25,34}$/) && !receiverAddress.startsWith('ltc1')) {
      await message.reply({ embeds: [new EmbedBuilder().setColor(COLORS.danger).setDescription('> ❌  Invalid LTC address. Please check and try again.')] });
      return;
    }

    tradeData.status = 'sending';
    const fee = tradeData.ltcAmount * FEE_PERCENT / 100;
    const receiverGets = tradeData.ltcAmount - fee;

    const loadingMsg = await message.channel.send({
      embeds: [new EmbedBuilder().setColor(COLORS.primary).setDescription(`\`\`\`\n  ⚡ Sending ${receiverGets.toFixed(6)} LTC to your wallet...\n\`\`\``)]
    });

    try {
      const txHash = await sendLTC(tradeData.privateKey, tradeData.address, receiverAddress, receiverGets);
      tradeData.status = 'complete';
      await loadingMsg.delete().catch(() => {});

      const successEmbed = new EmbedBuilder()
        .setColor(COLORS.success)
        .setTitle('◈  TRADE COMPLETE  🎉')
        .setDescription(
          '```\n  Transaction Executed Successfully\n```\n' + DIVIDER + '\n\n' +
          `> ✅  **${receiverGets.toFixed(6)} LTC** sent to receiver\n` +
          `> 🟢  **Sender:** <@${tradeData.senderId}>\n` +
          `> 🔵  **Receiver:** <@${tradeData.receiverId}>\n\n` + DIVIDER
        )
        .addFields(
          { name: '📬  SENT TO ADDRESS', value: `\`\`\`${receiverAddress}\`\`\`` },
          { name: '🔗  TRANSACTION HASH', value: `\`\`\`${txHash}\`\`\`` },
          { name: '\u200b', value: DIVIDER + '\n> Thank you for using **Imu Escrow**.\n> Press **Close Ticket** to archive.' },
        )
        .setFooter({ text: `◈ Imu Escrow  •  Trade #ltc-${tradeId}  •  Completed` })
        .setTimestamp();

      const closeRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`close_${tradeId}`).setLabel('🔒  Close Ticket').setStyle(ButtonStyle.Secondary),
      );

      await message.channel.send({
        content: `<@${tradeData.senderId}> <@${tradeData.receiverId}>`,
        embeds: [successEmbed],
        components: [closeRow],
      });
    } catch (e) {
      tradeData.status = 'funded';
      await loadingMsg.delete().catch(() => {});
      console.error('Send LTC error:', e.message);
      const adminPing = ADMIN_ROLE_ID ? `<@&${ADMIN_ROLE_ID}>` : '@Admin';
      await message.channel.send({
        embeds: [new EmbedBuilder().setColor(COLORS.danger).setTitle('◈  AUTO-SEND FAILED')
          .setDescription('```\n  Manual Transfer Required\n```\n' + DIVIDER + '\n\n' +
            `${adminPing} please manually send **${receiverGets.toFixed(6)} LTC** to:\n\`\`\`${receiverAddress}\`\`\``)
          .setFooter({ text: `◈ Imu Escrow  •  Trade #ltc-${tradeId}` })]
      });
    }
  }
});

client.login(BOT_TOKEN);
