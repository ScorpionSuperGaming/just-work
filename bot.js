const { Client, GatewayIntentBits, SlashCommandBuilder, PermissionFlagsBits, ChannelType, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require('discord.js');
const { REST } = require('@discordjs/rest');
const { Routes } = require('discord-api-types/v10');
const axios = require('axios');
const crypto = require('crypto');

// ── CONFIG (filled from environment variables) ──────────────────────────────
const BOT_TOKEN       = process.env.BOT_TOKEN;
const CLIENT_ID       = process.env.CLIENT_ID;
const BLOCKCYPHER_KEY = process.env.BLOCKCYPHER_KEY;
const YOUR_LTC_ADDRESS= process.env.YOUR_LTC_ADDRESS;   // your personal LTC wallet
const ADMIN_ROLE_ID   = process.env.ADMIN_ROLE_ID;      // role to ping on disputes
const FEE_PERCENT     = parseFloat(process.env.FEE_PERCENT || '1'); // default 1%

// ── IN-MEMORY TRADE STORE ───────────────────────────────────────────────────
// { tradeId: { buyerId, sellerId, amount, address, channelId, status, buyerConfirmed, sellerConfirmed } }
const trades = {};

// ── DISCORD CLIENT ──────────────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ],
});

// ── REGISTER SLASH COMMANDS ─────────────────────────────────────────────────
const commands = [
  new SlashCommandBuilder()
    .setName('escrow')
    .setDescription('Start a new escrow trade')
    .addUserOption(o => o.setName('buyer').setDescription('The buyer').setRequired(true))
    .addUserOption(o => o.setName('seller').setDescription('The seller').setRequired(true))
    .addNumberOption(o => o.setName('amount').setDescription('Amount in LTC').setRequired(true)),
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

// ── GENERATE UNIQUE TRADE ID ────────────────────────────────────────────────
function generateTradeId() {
  return crypto.randomBytes(4).toString('hex').toUpperCase();
}

// ── GENERATE LTC ADDRESS VIA BLOCKCYPHER ────────────────────────────────────
async function generateLTCAddress() {
  const res = await axios.post(
    `https://api.blockcypher.com/v1/ltc/main/addrs?token=${BLOCKCYPHER_KEY}`
  );
  return { address: res.data.address, private: res.data.private, public: res.data.public };
}

// ── CHECK ADDRESS BALANCE ────────────────────────────────────────────────────
async function checkBalance(address) {
  const res = await axios.get(
    `https://api.blockcypher.com/v1/ltc/main/addrs/${address}/balance?token=${BLOCKCYPHER_KEY}`
  );
  return res.data.balance / 1e8; // convert satoshis to LTC
}

// ── WATCH FOR PAYMENT (polls every 30s for up to 1 hour) ───────────────────
async function watchForPayment(tradeId) {
  const trade = trades[tradeId];
  const expected = trade.amount;
  const maxAttempts = 120; // 120 x 30s = 1 hour
  let attempts = 0;

  const interval = setInterval(async () => {
    attempts++;
    if (attempts > maxAttempts) {
      clearInterval(interval);
      const ch = await client.channels.fetch(trade.channelId);
      await ch.send('⏰ **Trade timed out.** No payment received within 1 hour. Trade cancelled.');
      trade.status = 'expired';
      return;
    }

    try {
      const balance = await checkBalance(trade.address);
      if (balance >= expected) {
        clearInterval(interval);
        trade.status = 'funded';

        const ch = await client.channels.fetch(trade.channelId);
        const fee = (expected * FEE_PERCENT / 100).toFixed(6);
        const sellerReceives = (expected - parseFloat(fee)).toFixed(6);

        const embed = new EmbedBuilder()
          .setColor(0x00c853)
          .setTitle('✅ Payment Confirmed!')
          .setDescription(`**${balance.toFixed(6)} LTC** received!`)
          .addFields(
            { name: '💰 Trade Amount', value: `${expected} LTC`, inline: true },
            { name: '📋 Fee (${FEE_PERCENT}%)', value: `${fee} LTC`, inline: true },
            { name: '🤝 Seller Receives', value: `${sellerReceives} LTC`, inline: true },
          )
          .setFooter({ text: 'Both parties must confirm below to release funds.' });

        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`confirm_${tradeId}`).setLabel('✅ Confirm Trade Complete').setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId(`dispute_${tradeId}`).setLabel('⚠️ Open Dispute').setStyle(ButtonStyle.Danger),
        );

        await ch.send({ content: `<@${trade.buyerId}> <@${trade.sellerId}>`, embeds: [embed], components: [row] });
      }
    } catch (e) {
      console.error('Balance check error:', e.message);
    }
  }, 30000);
}

// ── READY ───────────────────────────────────────────────────────────────────
client.once('ready', () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  registerCommands();
});

// ── SLASH COMMAND HANDLER ───────────────────────────────────────────────────
client.on('interactionCreate', async interaction => {

  // ── /escrow command ──
  if (interaction.isChatInputCommand() && interaction.commandName === 'escrow') {
    await interaction.deferReply({ ephemeral: true });

    const buyer  = interaction.options.getUser('buyer');
    const seller = interaction.options.getUser('seller');
    const amount = interaction.options.getNumber('amount');

    if (buyer.id === seller.id) {
      return interaction.editReply('❌ Buyer and seller cannot be the same person.');
    }
    if (amount <= 0) {
      return interaction.editReply('❌ Amount must be greater than 0.');
    }

    const tradeId = generateTradeId();
    let walletData;
    try {
      walletData = await generateLTCAddress();
    } catch (e) {
      return interaction.editReply('❌ Failed to generate LTC address. Check your Blockcypher key.');
    }

    // Create private channel
    const channel = await interaction.guild.channels.create({
      name: `trade-${tradeId}`,
      type: ChannelType.GuildText,
      permissionOverwrites: [
        { id: interaction.guild.roles.everyone, deny: [PermissionFlagsBits.ViewChannel] },
        { id: buyer.id,  allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] },
        { id: seller.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] },
        { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageChannels] },
      ],
    });

    trades[tradeId] = {
      buyerId: buyer.id,
      sellerId: seller.id,
      amount,
      address: walletData.address,
      channelId: channel.id,
      status: 'awaiting_payment',
      buyerConfirmed: false,
      sellerConfirmed: false,
    };

    const embed = new EmbedBuilder()
      .setColor(0xf4c542)
      .setTitle(`🔒 Escrow Trade #${tradeId}`)
      .setDescription('A new escrow trade has been created. The buyer must send LTC to the address below.')
      .addFields(
        { name: '🛒 Buyer',   value: `<@${buyer.id}>`,  inline: true },
        { name: '🏪 Seller',  value: `<@${seller.id}>`, inline: true },
        { name: '💎 Amount',  value: `${amount} LTC`,   inline: true },
        { name: '📬 Send LTC to this address', value: `\`\`\`${walletData.address}\`\`\`` },
        { name: '⚠️ Important', value: 'Send **exactly** the amount above. Bot will auto-confirm after 1 blockchain confirmation.' },
      )
      .setFooter({ text: 'Do NOT close this channel until the trade is complete.' });

    await channel.send({ content: `<@${buyer.id}> <@${seller.id}> — Trade started!`, embeds: [embed] });
    await interaction.editReply(`✅ Trade channel created: ${channel}`);

    // Start watching for payment
    watchForPayment(tradeId);
  }

  // ── Button interactions ──
  if (interaction.isButton()) {
    const [action, tradeId] = interaction.customId.split('_');
    const trade = trades[tradeId];

    if (!trade) return interaction.reply({ content: '❌ Trade not found.', ephemeral: true });

    // Confirm button
    if (action === 'confirm') {
      if (interaction.user.id !== trade.buyerId && interaction.user.id !== trade.sellerId) {
        return interaction.reply({ content: '❌ You are not part of this trade.', ephemeral: true });
      }

      if (interaction.user.id === trade.buyerId)  trade.buyerConfirmed  = true;
      if (interaction.user.id === trade.sellerId) trade.sellerConfirmed = true;

      await interaction.reply({ content: `✅ <@${interaction.user.id}> confirmed the trade.` });

      if (trade.buyerConfirmed && trade.sellerConfirmed) {
        trade.status = 'complete';
        const fee = (trade.amount * FEE_PERCENT / 100).toFixed(6);
        const sellerReceives = (trade.amount - parseFloat(fee)).toFixed(6);

        const embed = new EmbedBuilder()
          .setColor(0x00c853)
          .setTitle('🎉 Trade Complete!')
          .setDescription('Both parties have confirmed. The middleman will now release the funds.')
          .addFields(
            { name: '💸 Seller should receive', value: `**${sellerReceives} LTC**` },
            { name: '📬 Seller LTC address', value: 'Seller: please post your LTC address below so the middleman can send your funds.' },
          );

        await interaction.channel.send({ embeds: [embed] });
      }
    }

    // Dispute button
    if (action === 'dispute') {
      if (interaction.user.id !== trade.buyerId && interaction.user.id !== trade.sellerId) {
        return interaction.reply({ content: '❌ You are not part of this trade.', ephemeral: true });
      }

      trade.status = 'disputed';
      const adminPing = ADMIN_ROLE_ID ? `<@&${ADMIN_ROLE_ID}>` : '@Admin';
      await interaction.reply({
        content: `⚠️ **Dispute opened by <@${interaction.user.id}>!**\n${adminPing} please review this trade.`,
      });
    }
  }
});

client.login(BOT_TOKEN);
