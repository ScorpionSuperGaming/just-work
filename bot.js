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
const crypto = require('crypto');

// ── CONFIG ────────────────────────────────────────────────────────────────────
const BOT_TOKEN       = process.env.BOT_TOKEN;
const CLIENT_ID       = process.env.CLIENT_ID;
const BLOCKCYPHER_KEY = process.env.BLOCKCYPHER_KEY;
const ADMIN_ROLE_ID   = process.env.ADMIN_ROLE_ID;
const FEE_PERCENT     = parseFloat(process.env.FEE_PERCENT || '1');

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
    .setDescription('Post the New Trade button in this channel')
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
  // Try mention
  const mentionMatch = input.match(/^<@!?(\d+)>$/);
  if (mentionMatch) return guild.members.fetch(mentionMatch[1]).catch(() => null);
  // Try raw ID
  if (/^\d{15,20}$/.test(input)) return guild.members.fetch(input).catch(() => null);
  // Try username
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
    if (attempts > maxAttempts || !['awaiting_payment'].includes(trade.status)) {
      clearInterval(interval);
      if (trade.status === 'awaiting_payment') {
        const ch = await client.channels.fetch(trade.channelId).catch(() => null);
        if (ch) await ch.send('⏰ **Trade timed out.** No payment received within 1 hour.');
        trade.status = 'expired';
      }
      return;
    }
    try {
      const balance = await getLTCBalance(trade.address);
      if (balance >= trade.amount) {
        clearInterval(interval);
        trade.status = 'funded';
        const ch = await client.channels.fetch(trade.channelId).catch(() => null);
        if (!ch) return;
        const fee = (trade.amount * FEE_PERCENT / 100).toFixed(6);
        const receiverGets = (trade.amount - parseFloat(fee)).toFixed(6);
        const embed = new EmbedBuilder()
          .setColor(0x2ECC71)
          .setTitle('✅ Payment Confirmed!')
          .setDescription(`**${trade.amount} LTC** received!\n\n<@${trade.senderId}> click **Release Funds** when you're happy with the trade.`)
          .addFields(
            { name: '🤝 Receiver will get', value: `${receiverGets} LTC`, inline: true },
            { name: '📋 Fee', value: `${fee} LTC`, inline: true },
          )
          .setFooter({ text: 'Imu Escrow' });
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`release_${tradeId}`).setLabel('✅ Release Funds').setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId(`dispute_${tradeId}`).setLabel('⚠️ Dispute').setStyle(ButtonStyle.Danger),
        );
        await ch.send({ content: `<@${trade.senderId}> <@${trade.receiverId}>`, embeds: [embed], components: [row] });
      }
    } catch (e) { console.error('Balance check error:', e.message); }
  }, 30000);
}

// ── READY ─────────────────────────────────────────────────────────────────────
client.once('ready', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  await registerCommands();
});

// ── INTERACTIONS ──────────────────────────────────────────────────────────────
client.on(Events.InteractionCreate, async interaction => {

  // /setup
  if (interaction.isChatInputCommand() && interaction.commandName === 'setup') {
    const embed = new EmbedBuilder()
      .setColor(0x9B59B6)
      .setTitle('💎 Imu Escrow')
      .setDescription('Safe and fully automated LTC escrow service.\n\nClick below to start a new trade. A private ticket will be created for you and your trader.')
      .addFields(
        { name: '✅ Secure', value: 'Unique LTC address per trade', inline: true },
        { name: '⚡ Automatic', value: 'Bot sends funds automatically', inline: true },
        { name: '🔒 Private', value: 'Only you & your trader can see', inline: true },
      )
      .setFooter({ text: 'Imu Escrow • Powered by LTC' });
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('new_trade').setLabel('🔒 New Trade').setStyle(ButtonStyle.Primary),
    );
    await interaction.channel.send({ embeds: [embed], components: [row] });
    await interaction.reply({ content: '✅ Done!', ephemeral: true });
    return;
  }

  // "New Trade" button → show modal form
  if (interaction.isButton() && interaction.customId === 'new_trade') {
    const modal = new ModalBuilder()
      .setCustomId('trade_form')
      .setTitle('Start a New Trade');

    const traderInput = new TextInputBuilder()
      .setCustomId('trader_id')
      .setLabel("Your Trader's Username or ID")
      .setPlaceholder('e.g. darkimu or 123456789012345678')
      .setStyle(TextInputStyle.Short)
      .setRequired(true);

    const givingInput = new TextInputBuilder()
      .setCustomId('you_giving')
      .setLabel('What are YOU giving?')
      .setPlaceholder('e.g. 0.5 LTC')
      .setStyle(TextInputStyle.Short)
      .setRequired(true);

    const receivingInput = new TextInputBuilder()
      .setCustomId('they_giving')
      .setLabel('What are THEY giving?')
      .setPlaceholder('e.g. 50 USDT')
      .setStyle(TextInputStyle.Short)
      .setRequired(true);

    const ltcAmountInput = new TextInputBuilder()
      .setCustomId('ltc_amount')
      .setLabel('LTC amount to escrow (numbers only)')
      .setPlaceholder('e.g. 0.5')
      .setStyle(TextInputStyle.Short)
      .setRequired(true);

    modal.addComponents(
      new ActionRowBuilder().addComponents(traderInput),
      new ActionRowBuilder().addComponents(givingInput),
      new ActionRowBuilder().addComponents(receivingInput),
      new ActionRowBuilder().addComponents(ltcAmountInput),
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
    const ltcAmount  = parseFloat(interaction.fields.getTextInputValue('ltc_amount'));

    if (isNaN(ltcAmount) || ltcAmount <= 0) {
      return interaction.editReply({ content: '❌ Invalid LTC amount. Please use a number like `0.5`' });
    }

    // Resolve the other trader
    const traderMember = await resolveUser(interaction.guild, traderId);
    if (!traderMember) {
      return interaction.editReply({ content: `❌ Could not find user **${traderId}** in this server. Make sure they are in the server and check the username/ID.` });
    }
    if (traderMember.id === interaction.user.id) {
      return interaction.editReply({ content: '❌ You cannot trade with yourself.' });
    }

    const tradeId = generateTradeId();
    const creator = interaction.user;
    const trader  = traderMember.user;

    // Create private channel
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
      youGiving,
      theyGiving,
      amount: ltcAmount,
      address: null,
      privateKey: null,
      status: 'selecting_roles',
      funded: false,
    };

    const fee = (ltcAmount * FEE_PERCENT / 100).toFixed(6);
    const receiverGets = (ltcAmount - parseFloat(fee)).toFixed(6);

    const welcomeEmbed = new EmbedBuilder()
      .setColor(0x9B59B6)
      .setTitle(`🔒 Trade #ltc-${tradeId}`)
      .setDescription(`Welcome <@${creator.id}> and <@${trader.id}>!\n\nPlease select your roles below to begin the trade.`)
      .addFields(
        { name: '📦 Trade Details', value: `<@${creator.id}> gives: **${youGiving}**\n<@${trader.id}> gives: **${theyGiving}**` },
        { name: '💎 LTC in Escrow', value: `${ltcAmount} LTC`, inline: true },
        { name: '🤝 Receiver gets', value: `${receiverGets} LTC`, inline: true },
        { name: '📋 Fee', value: `${fee} LTC (${FEE_PERCENT}%)`, inline: true },
      )
      .setFooter({ text: 'Imu Escrow • Both parties must select their role' });

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`role_sender_${tradeId}`).setLabel('🟢 I am Sending LTC').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`role_receiver_${tradeId}`).setLabel('🔵 I am Receiving LTC').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`cancel_${tradeId}`).setLabel('🔴 Cancel Trade').setStyle(ButtonStyle.Danger),
    );

    await channel.send({ content: `<@${creator.id}> <@${trader.id}> — Trade created!`, embeds: [welcomeEmbed], components: [row] });
    await interaction.editReply({ content: `✅ Trade ticket created: ${channel}` });
    return;
  }

  // Role buttons
  if (interaction.isButton() && interaction.customId.startsWith('role_')) {
    const parts = interaction.customId.split('_');
    const role = parts[1];
    const tradeId = parts[2];
    const trade = trades[tradeId];
    if (!trade) return interaction.reply({ content: '❌ Trade not found.', ephemeral: true });
    if (trade.status !== 'selecting_roles') return interaction.reply({ content: '❌ Roles already locked in.', ephemeral: true });

    const userId = interaction.user.id;
    if (userId !== trade.creatorId && userId !== trade.traderId) {
      return interaction.reply({ content: '❌ You are not part of this trade.', ephemeral: true });
    }

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

    await interaction.reply({ content: `✅ <@${userId}> is the **${role === 'sender' ? '🟢 Sender' : '🔵 Receiver'}**!` });

    if (trade.senderId && trade.receiverId) {
      trade.status = 'generating_address';
      const loadingMsg = await interaction.channel.send('⏳ Both roles confirmed! Generating your unique LTC address...');

      try {
        const wallet = await generateLTCAddress();
        trade.address = wallet.address;
        trade.privateKey = wallet.privateKey;
        trade.status = 'awaiting_payment';

        await loadingMsg.delete().catch(() => {});

        const fee = (trade.amount * FEE_PERCENT / 100).toFixed(6);
        const receiverGets = (trade.amount - parseFloat(fee)).toFixed(6);

        const payEmbed = new EmbedBuilder()
          .setColor(0xF1C40F)
          .setTitle(`⏳ Awaiting Payment — Trade #ltc-${tradeId}`)
          .setDescription(`<@${trade.senderId}> please send **exactly ${trade.amount} LTC** to the address below.`)
          .addFields(
            { name: '🟢 Sender', value: `<@${trade.senderId}>`, inline: true },
            { name: '🔵 Receiver', value: `<@${trade.receiverId}>`, inline: true },
            { name: '💎 Amount', value: `${trade.amount} LTC`, inline: true },
            { name: '📬 Send LTC here', value: `\`\`\`${wallet.address}\`\`\`` },
            { name: '🤝 Receiver gets', value: `${receiverGets} LTC`, inline: true },
            { name: '📋 Fee', value: `${fee} LTC`, inline: true },
          )
          .setFooter({ text: 'Imu Escrow • Payment checked every 30 seconds' });

        await interaction.channel.send({ content: `<@${trade.senderId}> <@${trade.receiverId}>`, embeds: [payEmbed] });
        watchForPayment(tradeId);
      } catch (e) {
        trade.status = 'selecting_roles';
        await loadingMsg.delete().catch(() => {});
        await interaction.channel.send('❌ Failed to generate LTC address. Please try again.');
      }
    }
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
    await interaction.reply({ content: `✅ Funds released by <@${trade.senderId}>!\n\n<@${trade.receiverId}> please type your **LTC wallet address** in this channel to receive your funds.` });
    return;
  }

  // Dispute
  if (interaction.isButton() && interaction.customId.startsWith('dispute_')) {
    const tradeId = interaction.customId.split('_')[1];
    const trade = trades[tradeId];
    if (!trade) return interaction.reply({ content: '❌ Trade not found.', ephemeral: true });
    if (interaction.user.id !== trade.senderId && interaction.user.id !== trade.receiverId) {
      return interaction.reply({ content: '❌ You are not part of this trade.', ephemeral: true });
    }
    trade.status = 'disputed';
    const adminPing = ADMIN_ROLE_ID ? `<@&${ADMIN_ROLE_ID}>` : '@Admin';
    await interaction.reply({ content: `⚠️ **Dispute opened by <@${interaction.user.id}>!**\n${adminPing} please review this trade.` });
    return;
  }

  // Cancel
  if (interaction.isButton() && interaction.customId.startsWith('cancel_')) {
    const tradeId = interaction.customId.split('_')[1];
    const trade = trades[tradeId];
    if (!trade) return interaction.reply({ content: '❌ Trade not found.', ephemeral: true });
    if (trade.funded) return interaction.reply({ content: '❌ Cannot cancel — funds already received.', ephemeral: true });
    if (interaction.user.id !== trade.creatorId && interaction.user.id !== trade.traderId) {
      return interaction.reply({ content: '❌ You are not part of this trade.', ephemeral: true });
    }
    trade.status = 'cancelled';
    await interaction.reply({ content: '🔴 Trade cancelled. Channel will be deleted in 5 seconds.' });
    setTimeout(async () => { await interaction.channel.delete().catch(() => {}); }, 5000);
    return;
  }

  // Close ticket
  if (interaction.isButton() && interaction.customId.startsWith('close_')) {
    await interaction.reply({ content: '🔒 Closing ticket in 5 seconds...' });
    setTimeout(async () => { await interaction.channel.delete().catch(() => {}); }, 5000);
    return;
  }
});

// ── MESSAGE HANDLER (receiver address) ───────────────────────────────────────
client.on(Events.MessageCreate, async message => {
  if (message.author.bot) return;
  const trade = Object.entries(trades).find(([, t]) => t.channelId === message.channel.id);
  if (!trade) return;
  const [tradeId, tradeData] = trade;

  if (tradeData.status === 'awaiting_receiver_address' && message.author.id === tradeData.receiverId) {
    const receiverAddress = message.content.trim();
    if (!receiverAddress.match(/^[LM3][a-km-zA-HJ-NP-Z1-9]{25,34}$/) && !receiverAddress.startsWith('ltc1')) {
      await message.reply('❌ That doesn\'t look like a valid LTC address. Please check and try again.');
      return;
    }

    tradeData.status = 'sending';
    const fee = tradeData.amount * FEE_PERCENT / 100;
    const receiverGets = tradeData.amount - fee;
    const loadingMsg = await message.channel.send(`⏳ Sending **${receiverGets.toFixed(6)} LTC** to your wallet...`);

    try {
      const txHash = await sendLTC(tradeData.privateKey, tradeData.address, receiverAddress, receiverGets);
      tradeData.status = 'complete';
      await loadingMsg.delete().catch(() => {});

      const successEmbed = new EmbedBuilder()
        .setColor(0x2ECC71)
        .setTitle('🎉 Trade Complete!')
        .setDescription(`**${receiverGets.toFixed(6)} LTC** has been sent to <@${tradeData.receiverId}>!`)
        .addFields(
          { name: '📬 Sent to', value: `\`${receiverAddress}\`` },
          { name: '🔗 Transaction Hash', value: `\`${txHash}\`` },
        )
        .setFooter({ text: 'Imu Escrow • Thank you for using our service!' });

      const closeRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`close_${tradeId}`).setLabel('🔒 Close Ticket').setStyle(ButtonStyle.Secondary),
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
      await message.channel.send(`❌ Auto-send failed. ${adminPing} please manually send **${receiverGets.toFixed(6)} LTC** to \`${receiverAddress}\`.`);
    }
  }
});

client.login(BOT_TOKEN);
