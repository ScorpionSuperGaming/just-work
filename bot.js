const {
  Client, GatewayIntentBits, SlashCommandBuilder,
  PermissionFlagsBits, ChannelType, ActionRowBuilder,
  ButtonBuilder, ButtonStyle, EmbedBuilder, StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder, Events
} = require('discord.js');
const { REST } = require('@discordjs/rest');
const { Routes } = require('discord-api-types/v10');
const axios = require('axios');
const crypto = require('crypto');

// ── CONFIG ──────────────────────────────────────────────────────────────────
const BOT_TOKEN        = process.env.BOT_TOKEN;
const CLIENT_ID        = process.env.CLIENT_ID;
const BLOCKCYPHER_KEY  = process.env.BLOCKCYPHER_KEY;
const ADMIN_ROLE_ID    = process.env.ADMIN_ROLE_ID;
const FEE_PERCENT      = parseFloat(process.env.FEE_PERCENT || '1');
const SETUP_CHANNEL_ID = process.env.SETUP_CHANNEL_ID; // channel where "New Trade" button lives

// ── TRADE STORE ──────────────────────────────────────────────────────────────
const trades = {};
// { tradeId: { senderId, receiverId, amount, address, privateKey, channelId, status, funded } }

// ── CLIENT ───────────────────────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ],
});

// ── SLASH COMMANDS ───────────────────────────────────────────────────────────
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
  } catch (e) {
    console.error('Failed to register commands:', e);
  }
}

// ── HELPERS ───────────────────────────────────────────────────────────────────
function generateTradeId() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

async function generateLTCAddress() {
  const res = await axios.post(
    `https://api.blockcypher.com/v1/ltc/main/addrs?token=${BLOCKCYPHER_KEY}`
  );
  return { address: res.data.address, privateKey: res.data.private };
}

async function getLTCBalance(address) {
  const res = await axios.get(
    `https://api.blockcypher.com/v1/ltc/main/addrs/${address}/balance?token=${BLOCKCYPHER_KEY}`
  );
  return res.data.balance / 1e8;
}

async function sendLTC(fromPrivateKey, fromAddress, toAddress, amountLTC) {
  const satoshis = Math.floor(amountLTC * 1e8);
  const feeSatoshis = 10000; // ~0.0001 LTC network fee

  // Build transaction
  const newTx = {
    inputs: [{ addresses: [fromAddress] }],
    outputs: [{ addresses: [toAddress], value: satoshis - feeSatoshis }],
  };

  const txRes = await axios.post(
    `https://api.blockcypher.com/v1/ltc/main/txs/new?token=${BLOCKCYPHER_KEY}`,
    newTx
  );

  // Sign transaction
  const tmptx = txRes.data;
  const EC = require('elliptic').ec;
  const ec = new EC('secp256k1');
  const key = ec.keyFromPrivate(fromPrivateKey, 'hex');

  tmptx.pubkeys = [];
  tmptx.signatures = tmptx.tosign.map((tosign) => {
    tmptx.pubkeys.push(key.getPublic('hex'));
    return key.sign(tosign).toDER('hex');
  });

  // Send transaction
  const sendRes = await axios.post(
    `https://api.blockcypher.com/v1/ltc/main/txs/send?token=${BLOCKCYPHER_KEY}`,
    tmptx
  );

  return sendRes.data.tx.hash;
}

// ── EMBEDS ────────────────────────────────────────────────────────────────────
function mainEmbed() {
  return new EmbedBuilder()
    .setColor(0x9B59B6)
    .setTitle('💎 Imu Escrow')
    .setDescription('Safe and automated LTC escrow service.\n\nClick the button below to start a new trade. A private ticket will be created for you.')
    .addFields(
      { name: '✅ Secure', value: 'Every trade gets a unique LTC address', inline: true },
      { name: '⚡ Automatic', value: 'Bot detects payment and releases funds', inline: true },
      { name: '🔒 Private', value: 'Only buyer & seller can see the ticket', inline: true },
    )
    .setFooter({ text: 'Imu Escrow • Powered by LTC' });
}

function ticketWelcomeEmbed(tradeId) {
  return new EmbedBuilder()
    .setColor(0x9B59B6)
    .setTitle(`🔒 Trade #ltc-${tradeId}`)
    .setDescription('Welcome! Please select your roles below.\n\n🟢 **I am Sending** — You will send LTC\n🔵 **I am Receiving** — You will receive LTC\n\nBoth parties must click their role before the trade begins.')
    .setFooter({ text: 'Imu Escrow' });
}

function waitingForAmountEmbed(senderId, receiverId) {
  return new EmbedBuilder()
    .setColor(0xF1C40F)
    .setTitle('💰 Enter Trade Amount')
    .setDescription(`✅ Roles confirmed!\n\n🟢 **Sender:** <@${senderId}>\n🔵 **Receiver:** <@${receiverId}>\n\n<@${senderId}> please type the amount of LTC to send in this channel.\n\nExample: \`0.5\``)
    .setFooter({ text: 'Imu Escrow' });
}

function paymentEmbed(tradeId, address, amount, senderId, receiverId) {
  const fee = (amount * FEE_PERCENT / 100).toFixed(6);
  const receiverGets = (amount - parseFloat(fee)).toFixed(6);
  return new EmbedBuilder()
    .setColor(0xF1C40F)
    .setTitle(`⏳ Awaiting Payment — Trade #ltc-${tradeId}`)
    .setDescription(`<@${senderId}> please send **exactly ${amount} LTC** to the address below.`)
    .addFields(
      { name: '🟢 Sender', value: `<@${senderId}>`, inline: true },
      { name: '🔵 Receiver', value: `<@${receiverId}>`, inline: true },
      { name: '💎 Amount', value: `${amount} LTC`, inline: true },
      { name: '📬 Send LTC to this address', value: `\`\`\`${address}\`\`\`` },
      { name: '📋 Fee', value: `${fee} LTC (${FEE_PERCENT}%)`, inline: true },
      { name: '🤝 Receiver gets', value: `${receiverGets} LTC`, inline: true },
    )
    .setFooter({ text: 'Imu Escrow • Bot checks every 30 seconds' });
}

function confirmedEmbed(amount, senderId, receiverId) {
  const fee = (amount * FEE_PERCENT / 100).toFixed(6);
  const receiverGets = (amount - parseFloat(fee)).toFixed(6);
  return new EmbedBuilder()
    .setColor(0x2ECC71)
    .setTitle('✅ Payment Confirmed!')
    .setDescription(`**${amount} LTC** has been received!\n\n<@${senderId}> click **Release Funds** when you are ready to complete the trade.`)
    .addFields(
      { name: '🤝 Receiver will get', value: `${receiverGets} LTC`, inline: true },
      { name: '📋 Fee', value: `${fee} LTC`, inline: true },
    )
    .setFooter({ text: 'Imu Escrow' });
}

// ── WATCH FOR PAYMENT ─────────────────────────────────────────────────────────
async function watchForPayment(tradeId) {
  const trade = trades[tradeId];
  const maxAttempts = 120;
  let attempts = 0;

  const interval = setInterval(async () => {
    attempts++;
    if (attempts > maxAttempts || trade.status === 'cancelled') {
      clearInterval(interval);
      if (trade.status !== 'cancelled') {
        const ch = await client.channels.fetch(trade.channelId).catch(() => null);
        if (ch) await ch.send('⏰ **Trade timed out.** No payment received within 1 hour.');
        trade.status = 'expired';
      }
      return;
    }

    if (trade.status !== 'awaiting_payment') { clearInterval(interval); return; }

    try {
      const balance = await getLTCBalance(trade.address);
      if (balance >= trade.amount) {
        clearInterval(interval);
        trade.status = 'funded';
        trade.funded = true;

        const ch = await client.channels.fetch(trade.channelId).catch(() => null);
        if (!ch) return;

        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`release_${tradeId}`).setLabel('✅ Release Funds').setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId(`dispute_${tradeId}`).setLabel('⚠️ Dispute').setStyle(ButtonStyle.Danger),
        );

        await ch.send({
          content: `<@${trade.senderId}> <@${trade.receiverId}>`,
          embeds: [confirmedEmbed(trade.amount, trade.senderId, trade.receiverId)],
          components: [row],
        });
      }
    } catch (e) {
      console.error('Balance check error:', e.message);
    }
  }, 30000);
}

// ── READY ─────────────────────────────────────────────────────────────────────
client.once('ready', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  await registerCommands();
});

// ── INTERACTIONS ──────────────────────────────────────────────────────────────
client.on(Events.InteractionCreate, async interaction => {

  // /setup command — post the main button
  if (interaction.isChatInputCommand() && interaction.commandName === 'setup') {
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('new_trade').setLabel('🔒 New Trade').setStyle(ButtonStyle.Primary),
    );
    await interaction.channel.send({ embeds: [mainEmbed()], components: [row] });
    await interaction.reply({ content: '✅ Setup complete!', ephemeral: true });
    return;
  }

  // "New Trade" button — create ticket
  if (interaction.isButton() && interaction.customId === 'new_trade') {
    await interaction.deferReply({ ephemeral: true });
    const tradeId = generateTradeId();

    const channel = await interaction.guild.channels.create({
      name: `ltc-${tradeId}`,
      type: ChannelType.GuildText,
      permissionOverwrites: [
        { id: interaction.guild.roles.everyone, deny: [PermissionFlagsBits.ViewChannel] },
        { id: interaction.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
        { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ReadMessageHistory] },
      ],
    });

    trades[tradeId] = {
      channelId: channel.id,
      senderId: null,
      receiverId: null,
      amount: null,
      address: null,
      privateKey: null,
      status: 'selecting_roles',
      creatorId: interaction.user.id,
    };

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`role_sender_${tradeId}`).setLabel('🟢 I am Sending').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`role_receiver_${tradeId}`).setLabel('🔵 I am Receiving').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`cancel_${tradeId}`).setLabel('🔴 Cancel').setStyle(ButtonStyle.Danger),
    );

    await channel.send({ embeds: [ticketWelcomeEmbed(tradeId)], components: [row] });
    await interaction.editReply({ content: `✅ Your trade ticket has been created: ${channel}` });
    return;
  }

  // Role selection buttons
  if (interaction.isButton() && interaction.customId.startsWith('role_')) {
    const parts = interaction.customId.split('_');
    const role = parts[1]; // sender or receiver
    const tradeId = parts[2];
    const trade = trades[tradeId];
    if (!trade) return interaction.reply({ content: '❌ Trade not found.', ephemeral: true });
    if (trade.status !== 'selecting_roles') return interaction.reply({ content: '❌ Roles already selected.', ephemeral: true });

    const userId = interaction.user.id;

    if (role === 'sender') {
      if (trade.senderId === userId) return interaction.reply({ content: '❌ You already claimed Sender.', ephemeral: true });
      if (trade.receiverId === userId) return interaction.reply({ content: '❌ You are already the Receiver.', ephemeral: true });
      trade.senderId = userId;

      // Give sender access if they're new
      await interaction.channel.permissionOverwrites.edit(userId, {
        ViewChannel: true, SendMessages: true, ReadMessageHistory: true
      });
    }

    if (role === 'receiver') {
      if (trade.receiverId === userId) return interaction.reply({ content: '❌ You already claimed Receiver.', ephemeral: true });
      if (trade.senderId === userId) return interaction.reply({ content: '❌ You are already the Sender.', ephemeral: true });
      trade.receiverId = userId;

      // Give receiver access
      await interaction.channel.permissionOverwrites.edit(userId, {
        ViewChannel: true, SendMessages: true, ReadMessageHistory: true
      });
    }

    await interaction.reply({ content: `✅ <@${userId}> claimed the **${role === 'sender' ? '🟢 Sender' : '🔵 Receiver'}** role!` });

    // Both roles filled — ask for amount
    if (trade.senderId && trade.receiverId) {
      trade.status = 'awaiting_amount';
      await interaction.channel.send({
        embeds: [waitingForAmountEmbed(trade.senderId, trade.receiverId)],
      });
    }
    return;
  }

  // Release funds button
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

  // Dispute button
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

  // Cancel button
  if (interaction.isButton() && interaction.customId.startsWith('cancel_')) {
    const tradeId = interaction.customId.split('_')[1];
    const trade = trades[tradeId];
    if (!trade) return interaction.reply({ content: '❌ Trade not found.', ephemeral: true });
    if (trade.funded) return interaction.reply({ content: '❌ Cannot cancel — funds already received.', ephemeral: true });
    trade.status = 'cancelled';
    await interaction.reply({ content: '🔴 Trade cancelled. This channel will be deleted in 5 seconds.' });
    setTimeout(async () => {
      await interaction.channel.delete().catch(() => {});
    }, 5000);
    return;
  }

  // Close ticket button
  if (interaction.isButton() && interaction.customId.startsWith('close_')) {
    const tradeId = interaction.customId.split('_')[1];
    await interaction.reply({ content: '🔒 Closing ticket in 5 seconds...' });
    setTimeout(async () => {
      await interaction.channel.delete().catch(() => {});
    }, 5000);
    return;
  }
});

// ── MESSAGE HANDLER (amount input + receiver address) ─────────────────────────
client.on(Events.MessageCreate, async message => {
  if (message.author.bot) return;

  // Find trade for this channel
  const trade = Object.entries(trades).find(([, t]) => t.channelId === message.channel.id);
  if (!trade) return;

  const [tradeId, tradeData] = trade;

  // Awaiting amount from sender
  if (tradeData.status === 'awaiting_amount' && message.author.id === tradeData.senderId) {
    const amount = parseFloat(message.content.trim());
    if (isNaN(amount) || amount <= 0) {
      await message.reply('❌ Invalid amount. Please type a number like `0.5`');
      return;
    }

    tradeData.amount = amount;
    tradeData.status = 'generating_address';

    const loadingMsg = await message.channel.send('⏳ Generating your unique LTC address...');

    try {
      const wallet = await generateLTCAddress();
      tradeData.address = wallet.address;
      tradeData.privateKey = wallet.privateKey;
      tradeData.status = 'awaiting_payment';

      await loadingMsg.delete().catch(() => {});
      await message.channel.send({
        embeds: [paymentEmbed(tradeId, wallet.address, amount, tradeData.senderId, tradeData.receiverId)],
      });

      watchForPayment(tradeId);
    } catch (e) {
      tradeData.status = 'awaiting_amount';
      await loadingMsg.delete().catch(() => {});
      await message.channel.send('❌ Failed to generate LTC address. Please try again.');
    }
    return;
  }

  // Awaiting receiver's LTC address
  if (tradeData.status === 'awaiting_receiver_address' && message.author.id === tradeData.receiverId) {
    const receiverAddress = message.content.trim();

    // Basic LTC address validation
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
          { name: '🔗 Transaction', value: `\`${txHash}\`` },
        )
        .setFooter({ text: 'Imu Escrow • Thank you for using our service' });

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
      await message.channel.send(`❌ Failed to send LTC automatically. ${adminPing} please send **${receiverGets.toFixed(6)} LTC** to \`${receiverAddress}\` manually.`);
    }
    return;
  }
});

client.login(BOT_TOKEN);
