/**
 * Bot Service
 * Copyright © 2025 DarkSide Developers
 */

const {
    default: makeWASocket,
    useMultiFileAuthState,
    delay,
    makeCacheableSignalKeyStore,
    Browsers,
    jidNormalizedUser
} = require('@whiskeysockets/baileys');
const fs = require('fs-extra');
const path = require('path');
const pino = require('pino');
const { Bot } = require('../database/models');

const activeSockets = new Map();
const SESSION_BASE_PATH = './sessions';

// Ensure session directory exists
if (!fs.existsSync(SESSION_BASE_PATH)) {
    fs.mkdirSync(SESSION_BASE_PATH, { recursive: true });
}

// Create bot session
const createBotSession = async (bot, method = 'pair') => {
    try {
        const sessionPath = path.join(SESSION_BASE_PATH, `session_${bot.id}`);
        const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
        
        const logger = pino({ level: 'silent' });
        
        const socket = makeWASocket({
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, logger),
            },
            printQRInTerminal: false,
            logger,
            browser: Browsers.macOS('Safari')
        });

        // Store socket reference
        activeSockets.set(bot.id, socket);

        // Handle connection updates
        socket.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;
            
            if (qr && method === 'qr') {
                // Return QR data for QR method
                return qr;
            }
            
            if (connection === 'open') {
                await bot.update({
                    status: 'connected',
                    lastSeen: new Date()
                });
                
                // Emit real-time update
                global.io.emit('bot_status_update', {
                    botId: bot.id,
                    status: 'connected'
                });
                
                console.log(`Bot ${bot.id} connected successfully`);
            } else if (connection === 'close') {
                const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== 401;
                
                await bot.update({
                    status: shouldReconnect ? 'connecting' : 'disconnected'
                });
                
                activeSockets.delete(bot.id);
                
                if (shouldReconnect) {
                    console.log(`Bot ${bot.id} disconnected, attempting to reconnect...`);
                    setTimeout(() => createBotSession(bot), 5000);
                }
            }
        });

        // Handle credentials update
        socket.ev.on('creds.update', saveCreds);

        // Setup message handlers
        setupMessageHandlers(socket, bot);

        // Request pairing code for pair method
        if (method === 'pair' && !socket.authState.creds.registered) {
            let retries = 3;
            let code;
            
            while (retries > 0) {
                try {
                    await delay(1500);
                    code = await socket.requestPairingCode(bot.phoneNumber);
                    break;
                } catch (error) {
                    retries--;
                    console.warn(`Failed to request pairing code: ${error.message}, retries left: ${retries}`);
                    await delay(2000);
                }
            }
            
            return code;
        }

        return method === 'qr' ? 'QR_GENERATED' : 'SESSION_CREATED';
    } catch (error) {
        console.error('Create bot session error:', error);
        throw error;
    }
};

// Setup message handlers
const setupMessageHandlers = (socket, bot) => {
    socket.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message || msg.key.remoteJid === 'status@broadcast') return;

        try {
            // Update bot statistics
            const stats = bot.statistics || {};
            stats.messagesReceived = (stats.messagesReceived || 0) + 1;
            
            await bot.update({ statistics: stats });

            // Handle commands
            const text = msg.message.conversation || 
                        msg.message.extendedTextMessage?.text || '';
            
            if (text.startsWith(bot.settings.prefix || '.')) {
                const cmdName = text.slice((bot.settings.prefix || '.').length).split(' ')[0].toLowerCase();
                
                // Load and execute command
                await executeCommand(socket, msg, cmdName, bot);
                
                // Update command statistics
                stats.commandsExecuted = (stats.commandsExecuted || 0) + 1;
                await bot.update({ statistics: stats });
            }
        } catch (error) {
            console.error('Message handler error:', error);
        }
    });

    // Handle status updates
    socket.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (msg.key.remoteJid !== 'status@broadcast') return;

        try {
            if (bot.settings.autoViewStatus) {
                await socket.readMessages([msg.key]);
            }

            if (bot.settings.autoLikeStatus) {
                const emojis = ['❤️', '👍', '🔥', '💯', '🎉'];
                const randomEmoji = emojis[Math.floor(Math.random() * emojis.length)];
                
                await socket.sendMessage(
                    msg.key.remoteJid,
                    { react: { text: randomEmoji, key: msg.key } },
                    { statusJidList: [msg.key.participant] }
                );
            }
        } catch (error) {
            console.error('Status handler error:', error);
        }
    });
};

// Execute command
const executeCommand = async (socket, msg, cmdName, bot) => {
    try {
        // Load command from plugins
        const commandPath = path.join(__dirname, '..', 'plugins', `${cmdName}.js`);
        
        if (fs.existsSync(commandPath)) {
            delete require.cache[require.resolve(commandPath)];
            const command = require(commandPath);
            
            if (typeof command === 'function') {
                await command(socket, msg, bot);
            }
        }
    } catch (error) {
        console.error(`Command execution error for ${cmdName}:`, error);
    }
};

// Get bot status
const getBotStatus = async (botId) => {
    const socket = activeSockets.get(botId);
    
    if (!socket) {
        return { status: 'disconnected', online: false };
    }

    return {
        status: 'connected',
        online: true,
        user: socket.user,
        lastSeen: new Date()
    };
};

// Update bot settings
const updateBotSettings = async (botId, settings) => {
    const socket = activeSockets.get(botId);
    
    if (socket) {
        // Apply settings to live bot
        console.log(`Updated settings for bot ${botId}:`, settings);
        
        // Emit real-time update
        global.io.emit('bot_settings_update', {
            botId,
            settings
        });
    }
};

// Disconnect bot
const disconnectBot = async (botId) => {
    const socket = activeSockets.get(botId);
    
    if (socket) {
        socket.ws.close();
        activeSockets.delete(botId);
        
        await Bot.update(
            { status: 'disconnected' },
            { where: { id: botId } }
        );
    }
};

module.exports = {
    createBotSession,
    getBotStatus,
    updateBotSettings,
    disconnectBot
};