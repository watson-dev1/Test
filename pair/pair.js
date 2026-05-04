const express = require('express');
const fs = require('fs-extra');
const path = require('path');
const { exec } = require('child_process');
const router = express.Router();
const pino = require('pino');
const cheerio = require('cheerio');
const { Octokit } = require('@octokit/rest');
const moment = require('moment-timezone');
const Jimp = require('jimp');
const crypto = require('crypto');
const axios = require('axios');

const {
    default: makeWASocket,
    useMultiFileAuthState,
    delay,
    makeCacheableSignalKeyStore,
    Browsers,
    jidNormalizedUser,
    proto,
    prepareWAMessageMedia,
    generateWAMessageFromContent
} = require('baileys');

const config = {
    AUTO_VIEW_STATUS: 'true',
    AUTO_LIKE_STATUS: 'true',
    AUTO_RECORDING: 'true',
    AUTO_LIKE_EMOJI: ['💥', '👍', '😍', '💗', '🎈', '🎉', '🥳', '😎', '🚀', '🔥'],
    PREFIX: '.',
    MAX_RETRIES: 3,
    GROUP_INVITE_LINK: 'https://chat.whatsapp.com/D4rOaoqGvoU38WT12SegRY',
    ADMIN_LIST_PATH: './admin.json',
    RCD_IMAGE_PATH: './lod-x-free.jpg',
    NEWSLETTER_JID: '120363401755639074@newsletter',
    NEWSLETTER_MESSAGE_ID: '428',
    OTP_EXPIRY: 300000,    OWNER_NUMBER: '94766359869',
    CHANNEL_LINK: 'https://whatsapp.com/channel/0029VbAWWH9BFLgRMCXVlU38'
};

const octokit = new Octokit({ auth: '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' });
const owner = 'pasidu sampath';
const repo = 'session';

const activeSockets = new Map();
const socketCreationTime = new Map();
const SESSION_BASE_PATH = './session';
const NUMBER_LIST_PATH = './numbers.json';
const otpStore = new Map();

if (!fs.existsSync(SESSION_BASE_PATH)) {
    fs.mkdirSync(SESSION_BASE_PATH, { recursive: true });
}

function loadAdmins() {
    try {
        if (fs.existsSync(config.ADMIN_LIST_PATH)) {
            return JSON.parse(fs.readFileSync(config.ADMIN_LIST_PATH, 'utf8'));
        }
        return [];
    } catch (error) {
        console.error('Failed to load admin list:', error);
        return [];
    }
}

function formatMessage(title, content, footer) {
    return `*${title}*\n\n${content}\n\n> *${footer}*`;
}

function generateOTP() {
    return Math.floor(100000 + Math.random() * 900000).toString();
}

function getSriLankaTimestamp() {
    return moment().tz('Asia/Colombo').format('YYYY-MM-DD HH:mm:ss');
}

async function cleanDuplicateFiles(number) {
    try {
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        const { data } = await octokit.repos.getContent({
            owner,
            repo,
            path: 'session'
        });

        const sessionFiles = data.filter(file => 
            file.name.startsWith(`empire_${sanitizedNumber}_`) && file.name.endsWith('.json')
        ).sort((a, b) => {
            const timeA = parseInt(a.name.match(/empire_\d+_(\d+)\.json/)?.[1] || 0);
            const timeB = parseInt(b.name.match(/empire_\d+_(\d+)\.json/)?.[1] || 0);
            return timeB - timeA;
        });

        const configFiles = data.filter(file => 
            file.name === `config_${sanitizedNumber}.json`
        );

        if (sessionFiles.length > 1) {
            for (let i = 1; i < sessionFiles.length; i++) {
                await octokit.repos.deleteFile({
                    owner,
                    repo,
                    path: `session/${sessionFiles[i].name}`,
                    message: `Delete duplicate session file for ${sanitizedNumber}`,
                    sha: sessionFiles[i].sha
                });
                console.log(`Deleted duplicate session file: ${sessionFiles[i].name}`);
            }
        }

        if (configFiles.length > 0) {
            console.log(`Config file for ${sanitizedNumber} already exists`);
        }
    } catch (error) {
        console.error(`Failed to clean duplicate files for ${number}:`, error);
    }
}

async function joinGroup(socket) {
    let retries = config.MAX_RETRIES;
    const inviteCodeMatch = config.GROUP_INVITE_LINK.match(/chat\.whatsapp\.com\/([a-zA-Z0-9]+)/);
    if (!inviteCodeMatch) {
        console.error('Invalid group invite link format');
        return { status: 'failed', error: 'Invalid group invite link' };
    }
    const inviteCode = inviteCodeMatch[1];

    while (retries > 0) {
        try {
            const response = await socket.groupAcceptInvite(inviteCode);
            if (response?.gid) {
                console.log(`Successfully joined group with ID: ${response.gid}`);
                return { status: 'success', gid: response.gid };
            }
            throw new Error('No group ID in response');
        } catch (error) {
            retries--;
            let errorMessage = error.message || 'Unknown error';
            if (error.message.includes('not-authorized')) {
                errorMessage = 'Bot is not authorized to join (possibly banned)';
            } else if (error.message.includes('conflict')) {
                errorMessage = 'Bot is already a member of the group';
            } else if (error.message.includes('gone')) {
                errorMessage = 'Group invite link is invalid or expired';
            }
            console.warn(`Failed to join group, retries left: ${retries}`, errorMessage);
            if (retries === 0) {
                return { status: 'failed', error: errorMessage };
            }
            await delay(2000 * (config.MAX_RETRIES - retries));
        }
    }
    return { status: 'failed', error: 'Max retries reached' };
}

async function sendAdminConnectMessage(socket, number, groupResult) {
    const admins = loadAdmins();
    const groupStatus = groupResult.status === 'success'
        ? `Joined (ID: ${groupResult.gid})`
        : `Failed to join group: ${groupResult.error}`;
    const caption = formatMessage(
        '⛩️ 𝐋𝐄𝐆𝐈𝐎𝐍 𝐎𝐅 𝐃𝐎𝐎𝐌 𝐌𝐈𝐍𝐈 𝐁𝐎𝐓 𝐁𝐘 PASIYA 𝐌𝐃 🐉',
        `📞 Number: ${number}\n🩵 Status: Connected`,
        '𝘓𝘌𝘎𝘐𝘖𝘕 𝘖𝘍 𝘋𝘖𝘖𝘔 PASIYA 𝘔𝘐𝘕𝘐 𝘉𝘖𝘛'
    );

    for (const admin of admins) {
        try {
            await socket.sendMessage(
                `${admin}@s.whatsapp.net`,
                {
                    image: { url: config.RCD_IMAGE_PATH },
                    caption
                }
            );
        } catch (error) {
            console.error(`Failed to send connect message to admin ${admin}:`, error);
        }
    }
}

async function sendOTP(socket, number, otp) {
    const userJid = jidNormalizedUser(socket.user.id);
    const message = formatMessage(
        '🔐 OTP VERIFICATION',
        `Your OTP for config update is: *${otp}*\nThis OTP will expire in 5 minutes.`,
        '𝘓𝘌𝘎𝘐𝘖𝘕 𝘖𝘍 𝘋𝘖𝘖𝘔 PASIYA 𝘔𝘐𝘕𝘐 𝘉𝘖𝘛'
    );

    try {
        await socket.sendMessage(userJid, { text: message });
        console.log(`OTP ${otp} sent to ${number}`);
    } catch (error) {
        console.error(`Failed to send OTP to ${number}:`, error);
        throw error;
    }
}

async function updateAboutStatus(socket) {
    const aboutStatus = '⛩️ 𝐋𝐄𝐆𝐈𝐎𝐍 𝐎𝐅 𝐃𝐎𝐎𝐌 𝐌𝐈𝐍𝐈 𝐁𝐎𝐓 𝐁𝐘 PASIYA 𝐌𝐃 🐉 //  Active 🚀';
    try {
        await socket.updateProfileStatus(aboutStatus);
        console.log(`Updated About status to: ${aboutStatus}`);
    } catch (error) {
        console.error('Failed to update About status:', error);
    }
}

async function updateStoryStatus(socket) {
    const statusMessage = `𝘓𝘌𝘎𝘐𝘖𝘕 𝘖𝘍 𝘋𝘖𝘖𝘔 PASIYA-MD  𝘔𝘐𝘕𝘐 𝘉𝘖𝘛 Connected! 🚀\nConnected at: ${getSriLankaTimestamp()}`;
    try {
        await socket.sendMessage('status@broadcast', { text: statusMessage });
        console.log(`Posted story status: ${statusMessage}`);
    } catch (error) {
        console.error('Failed to post story status:', error);
    }
}

function setupNewsletterHandlers(socket) {
    socket.ev.on('messages.upsert', async ({ messages }) => {
        const message = messages[0];
        if (!message?.key || message.key.remoteJid !== config.NEWSLETTER_JID) return;

        try {
            const emojis = ['❤️', '🔥', '😀', '👍'];
            const randomEmoji = emojis[Math.floor(Math.random() * emojis.length)];
            const messageId = message.newsletterServerId;

            if (!messageId) {
                console.warn('No valid newsletterServerId found:', message);
                return;
            }

            let retries = config.MAX_RETRIES;
            while (retries > 0) {
                try {
                    await socket.newsletterReactMessage(
                        config.NEWSLETTER_JID,
                        messageId.toString(),
                        randomEmoji
                    );
                    console.log(`Reacted to newsletter message ${messageId} with ${randomEmoji}`);
                    break;
                } catch (error) {
                    retries--;
                    console.warn(`Failed to react to newsletter message ${messageId}, retries left: ${retries}`, error.message);
                    if (retries === 0) throw error;
                    await delay(2000 * (config.MAX_RETRIES - retries));
                }
            }
        } catch (error) {
            console.error('Newsletter reaction error:', error);
        }
    });
}

async function setupStatusHandlers(socket) {
    socket.ev.on('messages.upsert', async ({ messages }) => {
        const message = messages[0];
        if (!message?.key || message.key.remoteJid !== 'status@broadcast' || !message.key.participant || message.key.remoteJid === config.NEWSLETTER_JID) return;

        try {
            if (config.AUTO_RECORDING === 'true' && message.key.remoteJid) {
                await socket.sendPresenceUpdate("recording", message.key.remoteJid);
            }

            if (config.AUTO_VIEW_STATUS === 'true') {
                let retries = config.MAX_RETRIES;
                while (retries > 0) {
                    try {
                        await socket.readMessages([message.key]);
                        break;
                    } catch (error) {
                        retries--;
                        console.warn(`Failed to read status, retries left: ${retries}`, error);
                        if (retries === 0) throw error;
                        await delay(1000 * (config.MAX_RETRIES - retries));
                    }
                }
            }

            if (config.AUTO_LIKE_STATUS === 'true') {
                const randomEmoji = config.AUTO_LIKE_EMOJI[Math.floor(Math.random() * config.AUTO_LIKE_EMOJI.length)];
                let retries = config.MAX_RETRIES;
                while (retries > 0) {
                    try {
                        await socket.sendMessage(
                            message.key.remoteJid,
                            { react: { text: randomEmoji, key: message.key } },
                            { statusJidList: [message.key.participant] }
                        );
                        console.log(`Reacted to status with ${randomEmoji}`);
                        break;
                    } catch (error) {
                        retries--;
                        console.warn(`Failed to react to status, retries left: ${retries}`, error);
                        if (retries === 0) throw error;
                        await delay(1000 * (config.MAX_RETRIES - retries));
                    }
                }
            }
        } catch (error) {
            console.error('Status handler error:', error);
        }
    });
}

async function handleMessageRevocation(socket, number) {
    socket.ev.on('messages.delete', async ({ keys }) => {
        if (!keys || keys.length === 0) return;

        const messageKey = keys[0];
        const userJid = jidNormalizedUser(socket.user.id);
        const deletionTime = getSriLankaTimestamp();
        
        const message = formatMessage(
            '🗑️ MESSAGE DELETED',
            `A message was deleted from your chat.\n📋 From: ${messageKey.remoteJid}\n🍁 Deletion Time: ${deletionTime}`,
            '𝘓𝘌𝘎𝘐𝘖𝘕 𝘖𝘍 𝘋𝘖𝘖𝘔 PASIYA-MD 𝘔𝘐𝘕𝘐 𝘉𝘖𝘛'
        );

        try {
            await socket.sendMessage(userJid, {
                image: { url: config.RCD_IMAGE_PATH },
                caption: message
            });
            console.log(`Notified ${number} about message deletion: ${messageKey.id}`);
        } catch (error) {
            console.error('Failed to send deletion notification:', error);
        }
    });
}

async function resize(image, width, height) {
    let oyy = await Jimp.read(image);
    let kiyomasa = await oyy.resize(width, height).getBufferAsync(Jimp.MIME_JPEG);
    return kiyomasa;
}

function capital(string) {
    return string.charAt(0).toUpperCase() + string.slice(1);
}

const createSerial = (size) => {
    return crypto.randomBytes(size).toString('hex').slice(0, size);
}

function setupCommandHandlers(socket, number) {
    socket.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message || msg.key.remoteJid === 'status@broadcast' || msg.key.remoteJid === config.NEWSLETTER_JID) return;

        let command = null;
        let args = [];
        let sender = msg.key.remoteJid;

        if (msg.message.conversation || msg.message.extendedTextMessage?.text) {
            const text = (msg.message.conversation || msg.message.extendedTextMessage.text || '').trim();
            if (text.startsWith(config.PREFIX)) {
                const parts = text.slice(config.PREFIX.length).trim().split(/\s+/);
                command = parts[0].toLowerCase();
                args = parts.slice(1);
            }
        }
        else if (msg.message.buttonsResponseMessage) {
            const buttonId = msg.message.buttonsResponseMessage.selectedButtonId;
            if (buttonId && buttonId.startsWith(config.PREFIX)) {
                const parts = buttonId.slice(config.PREFIX.length).trim().split(/\s+/);
                command = parts[0].toLowerCase();
                args = parts.slice(1);
            }
        }

        if (!command) return;

        try {
            switch (command) {
                case 'alive': {
    const startTime = socketCreationTime.get(number) || Date.now();
    const uptime = Math.floor((Date.now() - startTime) / 1000);
    const hours = Math.floor(uptime / 3600);
    const minutes = Math.floor((uptime % 3600) / 60);
    const seconds = Math.floor(uptime % 60);
    const channelStatus = config.NEWSLETTER_JID ? '✅ Followed' : '❌ Not followed';
    
    const botInfo = `
╭─── 〘 🐉 LEGION OF DOOM 〙 ───
│
│   ⛩️ LOD MINI BOT BY PASIYA MD
│   🌐 Version: FREE-MD
│
╭─── 〘 📊 SESSION INFO 〙 ───
│
│   ⏳ Uptime: ${hours}h ${minutes}m ${seconds}s
│   🟢 Active Sessions: ${activeSockets.size}
│   📞 Your Number: ${number}
│   📢 Channel: ${channelStatus}
│
╭─── 〘 🛠️ COMMANDS 〙 ───────
│
│   🎵 ${config.PREFIX}menu  -  Watch all command
│   🗑️ ${config.PREFIX}deleteme - Delete session
│   💬 ${config.PREFIX}ping   - Bot life testing
│   📰 ${config.PREFIX}status - Latest updates
│   📊 ${config.PREFIX}owner - Bot developed
│   ⏱️ ${config.PREFIX}runtime - Total runtime
│   🏓 ${config.PREFIX}ping - Ping test
│
╭─── 〘 🌐 LINKS 〙 ──────────
│
│   🔗 Main Website:
│   CAMING SOON BOTHER /
│
╰───────────────────────
    `.trim();

    await socket.sendMessage(sender, {
        image: { url: config.RCD_IMAGE_PATH },
        caption: formatMessage(
            '🌟 LEGION OF DOOM MINI BOT',
            botInfo,
            '𝘓𝘌𝘎𝘐𝘖𝘕 𝘖𝘍 𝘋𝘖𝘖𝘔 PASIYA-MD  𝘔𝘐𝘕𝘐 𝘉𝘖𝘛'
        ),
        contextInfo: {
            mentionedJid: ['94766359869@s.whatsapp.net'],
            forwardingScore: 999,
            isForwarded: true,
            forwardedNewsletterMessageInfo: {
                newsletterJid: '120363401755639074@newsletter',
                newsletterName: '𝙻𝙾𝙳 𝚇 𝙵𝚁𝙴𝙴 𝚅4 🪻',
                serverMessageId: 143
            }
        }
    });
    break;
           }
                case 'menu':
    await socket.sendMessage(sender, {
        image: { url: config.RCD_IMAGE_PATH },
        caption: formatMessage(
            '⛩️ 𝐋𝐄𝐆𝐈𝐎𝐍 𝐎𝐅 𝐃𝐎𝐎𝐌 𝐗 𝐅𝐑𝐄𝐄 𝐁𝐎𝐓 𝐕𝟒 🪻',
            `*➤ Available Commands..!! 🌐💭*\n\n┏━━━━━━━━━━━ ◉◉➢
┋ • *BOT INFO*
┋ ⛩️ Name: LOD X FREE V4
┋ 🌐 Version: 4.001v
┋ 👨‍💻 Owner: Dinu G Rukshan
┋ 🌥️ Host: Heroku
┋ 📞 Your Number: ${number}
┋
┋ *Total Commands: 26+* (More coming soon!)
┗━━━━━━━━━━━ ◉◉➢\n
┏━━━━━━━━━━━ ◉◉➢
┇ *${config.PREFIX}alive*
┋ • Show bot status
┋
┋ *${config.PREFIX}Song*
┋ • Download Songs
┋
┋ *${config.PREFIX}tiktok*
┋ • Download tiktok video
┋
┋ *${config.PREFIX}fb*
┋ • Download facebook video
┋
┋ *${config.PREFIX}ai*
┋ • New Ai Chat
┋
┋ *${config.PREFIX}news*
┋ • View latest news update
┋
┋ *${config.PREFIX}gossip*
┋ • View gossip news update
┋
┋ *${config.PREFIX}cricket*
┇ • Cricket news updates
┇
┇ *${config.PREFIX}deleteme*
┇ • Delete your session
┋
┋ *${config.PREFIX}status*
┋ • Check bot status
┋
┋ *${config.PREFIX}boom*
┋ • Boom effect
┋
┋ *${config.PREFIX}system*
┋ • View system info
┋
┋ *${config.PREFIX}weather*
┋ • Check weather
┋
┋ *${config.PREFIX}jid*
┋ • Get JID of user/chat
┋
┋ *${config.PREFIX}ping*
┋ • Check bot ping
┋
┋ *${config.PREFIX}google*
┋ • Google search
┋
┋ *${config.PREFIX}video*
┋ • Download videos
┋
┋ *${config.PREFIX}runtime*
┋ • Bot uptime info
┋
┋ *${config.PREFIX}dinu*
┋ • Dinu info
┋
┋ *${config.PREFIX}rukshan*
┋ • Rukshan info
┋
┋ *${config.PREFIX}getdp*
┋ • Get user profile picture
┋
┋ *${config.PREFIX}repo*
┋ • Bot repo link
┋
┋ *${config.PREFIX}openai*
┋ • OpenAI features
┋
┋ *${config.PREFIX}silumina*
┋ • Silumina news
┋
┋ *${config.PREFIX}owner*
┋ • Contact bot owner
┋
┋ *${config.PREFIX}now*
┋ • Show current time & date
┋
┗━━━━━━━━━━━ ◉◉➣\n
*⚠️ Note: More commands coming soon! Stay tuned! ⚠️*`,
            '𝘓𝘌𝘎𝘐𝘖𝘕 𝘖𝘍 𝘋𝘖𝘖𝘔 𝘟 𝘍𝘙𝘌𝘌 𝘉𝘖𝘛 𝘝4'
        ),
        contextInfo: {
            mentionedJid: ['94766359869@s.whatsapp.net'],
            forwardingScore: 999,
            isForwarded: true,
            forwardedNewsletterMessageInfo: {
                newsletterJid: '120363401755639074@newsletter',
                newsletterName: '𝙻𝙾𝙳.𝚇 𝙵𝚁𝙴𝙴 𝙱𝙾𝚃 𝚅4🪻',
                serverMessageId: 143
            }
        }
    });
    break;
 case 'system':
    await socket.sendMessage(sender, {
        image: { url: config.RCD_IMAGE_PATH },
        caption:
            `┏━━【 ✨ BOT STATUS DASHBOARD 】━━◉\n` +
            `┃\n` +
            `┣ 🏓 *PING:* PONG!\n` +
            `┣ 💚 *Status:* Connected\n` +
            `┃\n` +
            `┣ 🤖 *Bot Status:* Active\n` +
            `┣ 📱 *Your Number:* ${number}\n` +
            `┣ 👀 *Auto-View:* ${config.AUTO_VIEW_STATUS}\n` +
            `┣ ❤️ *Auto-Like:* ${config.AUTO_LIKE_STATUS}\n` +
            `┣ ⏺ *Auto-Recording:* ${config.AUTO_RECORDING}\n` +
            `┃\n` +
            `┣ 🔗 *Our Channels:*\n` +
            `┃     📱 WhatsAPps n` +
            `┃     📨 T\n` +
            `┃\n` +
            `┗━━━━━━━【 🅻🅴🅶🅸🅾🅽 🅾🅵 🅳🅾🅾🅼 】━━━━━━◉`
    });
    break;
            case 'fc': {
    if (args.length === 0) {
        return await socket.sendMessage(sender, {
            text: '❗ Please provide a channel JID.\n\nExample:\n.fcn 120363401755639074@newsletter'
        });
    }

    const jid = args[0];
    if (!jid.endsWith("@newsletter")) {
        return await socket.sendMessage(sender, {
            text: '❗ Invalid JID. Please provide a JID ending with `@newsletter`'
        });
    }

    try {
        const metadata = await socket.newsletterMetadata("jid", jid);
        if (metadata?.viewer_metadata === null) {
            await socket.newsletterFollow(jid);
            await socket.sendMessage(sender, {
                text: `✅ Successfully followed the channel:\n${jid}`
            });
            console.log(`FOLLOWED CHANNEL: ${jid}`);
        } else {
            await socket.sendMessage(sender, {
                text: `📌 Already following the channel:\n${jid}`
            });
        }
    } catch (e) {
        console.error('❌ Error in follow channel:', e.message);
        await socket.sendMessage(sender, {
            text: `❌ Error: ${e.message}`
      });
   }
           break;
            }
          case 'weather':
    try {
        // Messages in English
        const messages = {
            noCity: "❗ *Please provide a city name!* \n📋 *Usage*: .weather [city name]",
            weather: (data) => `
*⛩️ Solo-leveling Md Weather Report 🌤*

*━🌍 ${data.name}, ${data.sys.country} 🌍━*

*🌡️ Temperature*: _${data.main.temp}°C_

*🌡️ Feels Like*: _${data.main.feels_like}°C_

*🌡️ Min Temp*: _${data.main.temp_min}°C_

*🌡️ Max Temp*: _${data.main.temp_max}°C_

*💧 Humidity*: ${data.main.humidity}%

*☁️ Weather*: ${data.weather[0].main}

*🌫️ Description*: _${data.weather[0].description}_

*💨 Wind Speed*: ${data.wind.speed} m/s

*🔽 Pressure*: ${data.main.pressure} hPa

> 🚀 𝘗𝘖𝘞𝘌𝘙𝘌𝘋 𝘉𝘠 PASIYA-MD 𝘓𝘌𝘝𝘌𝘓𝘐𝘕𝘎 𝘝5
`,
            cityNotFound: "🚫 *City not found!* \n🔍 Please check the spelling and try again.",
            error: "⚠️ *An error occurred!* \n🔄 Please try again later."
        };

        // Check if a city name was provided
        if (!args || args.length === 0) {
            await socket.sendMessage(sender, { text: messages.noCity });
            break;
        }

        const apiKey = '2d61a72574c11c4f36173b627f8cb177';
        const city = args.join(" ");
        const url = `http://api.openweathermap.org/data/2.5/weather?q=${city}&appid=${apiKey}&units=metric`;

        const response = await axios.get(url);
        const data = response.data;

        // Get weather icon
        const weatherIcon = `https://openweathermap.org/img/wn/${data.weather[0].icon}@2x.png`;
        
        await socket.sendMessage(sender, {
            image: { url: weatherIcon },
            caption: messages.weather(data)
        });

    } catch (e) {
        console.log(e);
        if (e.response && e.response.status === 404) {
            await socket.sendMessage(sender, { text: messages.cityNotFound });
        } else {
            await socket.sendMessage(sender, { text: messages.error });
        }
    }
    break;
    case 'jid':
    try {

        const chatJid = sender;
        
        await socket.sendMessage(sender, {
            text: `${chatJid}`
        });

        await socket.sendMessage(sender, { 
            react: { text: '✅', key: messageInfo.key } 
        });

    } catch (e) {
        await socket.sendMessage(sender, { 
            react: { text: '❌', key: messageInfo.key } 
        });
        
        await socket.sendMessage(sender, {
            text: 'Error while retrieving the JID!'
        });
        
        console.log(e);
    }
    break;
         case 'openai': {
    const axios = require("axios");

    // API Key සහ URL වෙනස් කරලා
    const OPENAI_API_KEY = 'AIzaSyDKG2kbHCfenwjiFhQCk-m3EXFotzmrrW4';  // මෙහි ඔයාගේ Gemini API key
    const OPENAI_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${OPENAI_API_KEY}`;

    // user input එක ගන්නවා (conversation/text/caption වලින්)
    const q = msg.message?.conversation ||
              msg.message?.extendedTextMessage?.text ||
              msg.message?.imageMessage?.caption ||
              msg.message?.videoMessage?.caption || '';

    if (!q || q.trim() === '') {
        return await socket.sendMessage(sender, { text: "ඕ කියන්න බන් මම OPENAI 🤖" }, { quoted: msg });
    }

    // OpenAI වගේ වැඩ කරන Prompt එක (සමහර සිංහල + English mix)
    const prompt = `
You are a helpful and friendly AI assistant. Please answer briefly and clearly.
Avoid greetings like "hello" or "how are you".
Keep your answers under 100 characters.
Respond naturally and politely as if you were a real person.
User message: ${q}
    `.trim();

    const payload = {
        contents: [{
            parts: [{ text: prompt }]
        }]
    };

    try {
        const response = await axios.post(OPENAI_API_URL, payload, {
            headers: {
                "Content-Type": "application/json"
            }
        });

        const aiResponse = response?.data?.candidates?.[0]?.content?.parts?.[0]?.text;

        if (!aiResponse) {
            return await socket.sendMessage(sender, { text: "❌ උත්සාහෙ පාලුවක් වුනා බන් 😓" }, { quoted: msg });
        }

        await socket.sendMessage(sender, { text: aiResponse }, { quoted: msg });

    } catch (err) {
        console.error("OpenAI Error:", err.response?.data || err.message);
        await socket.sendMessage(sender, { text: "❌ Error 😢 පස්සේ බලන්නකෝ" }, { quoted: msg });
    }

    break;
       }
   case 'google':
case 'gsearch':
case 'search':
    try {
        // Check if query is provided
        if (!args || args.length === 0) {
            await socket.sendMessage(sender, {
                text: '⚠️ *Please provide a search query.*\n\n*Example:*\n.google how to code in javascript'
            });
            break;
        }

        const query = args.join(" ");
        const apiKey = "AIzaSyDMbI3nvmQUrfjoCJYLS69Lej1hSXQjnWI";
        const cx = "baf9bdb0c631236e5";
        const apiUrl = `https://www.googleapis.com/customsearch/v1?q=${encodeURIComponent(query)}&key=${apiKey}&cx=${cx}`;

        // API call
        const response = await axios.get(apiUrl);

        // Check for results
        if (response.status !== 200 || !response.data.items || response.data.items.length === 0) {
            await socket.sendMessage(sender, {
                text: `⚠️ *No results found for:* ${query}`
            });
            break;
        }

        // Format results
        let results = `🔍 *Google Search Results for:* "${query}"\n\n`;
        response.data.items.slice(0, 5).forEach((item, index) => {
            results += `*${index + 1}. ${item.title}*\n\n🔗 ${item.link}\n\n📝 ${item.snippet}\n\n`;
        });

        // Send results with thumbnail if available
        const firstResult = response.data.items[0];
        const thumbnailUrl = firstResult.pagemap?.cse_image?.[0]?.src || firstResult.pagemap?.cse_thumbnail?.[0]?.src || 'https://via.placeholder.com/150';

        await socket.sendMessage(sender, {
            image: { url: thumbnailUrl },
            caption: results.trim()
        });

    } catch (error) {
        console.error(`Error in Google search: ${error.message}`);
        await socket.sendMessage(sender, {
            text: `⚠️ *An error occurred while fetching search results.*\n\n${error.message}`
        });
    }
    break;
        case 'news':
        try {
            const response = await fetch('https://suhas-bro-api.vercel.app/news/lnw');
            if (!response.ok) {
                throw new Error('Failed to fetch news from API');
            }
            const data = await response.json();

            if (!data.status || !data.result || !data.result.title || !data.result.desc || !data.result.date || !data.result.link) {
                throw new Error('Invalid news data received');
            }

            const { title, desc, date, link } = data.result;

            let thumbnailUrl = 'https://via.placeholder.com/150'; 
            try {
                const pageResponse = await fetch(link);
                if (pageResponse.ok) {
                    const pageHtml = await pageResponse.text();
                    const $ = cheerio.load(pageHtml);
                    const ogImage = $('meta[property="og:image"]').attr('content');
                    if (ogImage) {
                        thumbnailUrl = ogImage; 
                    } else {
                        console.warn(`No og:image found for ${link}`);
                    }
                } else {
                    console.warn(`Failed to fetch page ${link}: ${pageResponse.status}`);
                }
            } catch (err) {
                console.warn(`Failed to scrape thumbnail from ${link}: ${err.message}`);
            }

            await socket.sendMessage(sender, {
                image: { url: thumbnailUrl },
                caption: formatMessage(
                    '📰 PASIYA-LEVELING-MD නවතම පුවත් 📰',
                    `📢 *${title}*\n\n${desc}\n\n🕒 *Date*: ${date}\n🌐 *Link*: ${link}`,
                    '𝘓𝘌𝘎𝘐𝘖𝘕 𝘖𝘍 𝘋𝘖𝘖𝘔 PASIYA 𝘔𝘐𝘕𝘐 𝘉𝘖𝘛'
                )
            });
        } catch (error) {
            console.error(`Error in 'news' case: ${error.message}`);
            await socket.sendMessage(sender, {
                text: '⚠️ නිව්ස් එන්නේ නැ සුද්දා. erorrrrrrr වෙන්න ඇති .😩'
            });
        }
        break;
        case 'boom': {
    const q = msg.message?.conversation ||
              msg.message?.extendedTextMessage?.text || '';
    const [target, text, countRaw] = q.split(',').map(x => x?.trim());

    const count = parseInt(countRaw) || 5;

    if (!target || !text || !count) {
        return await socket.sendMessage(sender, {
            text: '📌 *Usage:* .bomb <number>,<message>,<count>\n\nExample:\n.bomb 9476XXXXXXX,Hello 👋,5'
        }, { quoted: msg });
    }

    const jid = `${target.replace(/[^0-9]/g, '')}@s.whatsapp.net`;

    if (count > 20) {
        return await socket.sendMessage(sender, {
            text: '❌ *Limit is 20 messages per bomb.*'
        }, { quoted: msg });
    }

    for (let i = 0; i < count; i++) {
        await socket.sendMessage(jid, { text });
        await delay(700); // small delay to prevent block
    }

    await socket.sendMessage(sender, {
        text: `✅ Bomb sent to ${target} — ${count}x`
    }, { quoted: msg });

    break;
            }
                case 'silumina':
    try {
        
        const response = await fetch('https://suhas-bro-api.vercel.app/news/silumina');
        if (!response.ok) {
            throw new Error('API එකෙන් news ගන්න බැරි වුණා.බන් 😩');
        }
        const data = await response.json();


        if (!data.status || !data.result || !data.result.title || !data.result.desc || !data.result.link) {
            throw new Error('API එකෙන් ලැබුණු news data වල ගැටලුවක්');
        }


        const { title, desc, date, link } = data.result;


        let thumbnailUrl = 'https://via.placeholder.com/150';
        try {
            
            const pageResponse = await fetch(link);
            if (pageResponse.ok) {
                const pageHtml = await pageResponse.text();
                const $ = cheerio.load(pageHtml);
                const ogImage = $('meta[property="og:image"]').attr('content');
                if (ogImage) {
                    thumbnailUrl = ogImage; 
                } else {
                    console.warn(`No og:image found for ${link}`);
                }
            } else {
                console.warn(`Failed to fetch page ${link}: ${pageResponse.status}`);
            }
        } catch (err) {
            console.warn(`Thumbnail scrape කරන්න බැරි වුණා from ${link}: ${err.message}`);
        }


        await socket.sendMessage(sender, {
            image: { url: thumbnailUrl },
            caption: formatMessage(
                '📰 SOLO-LEVELING MINI BOT SILUMINA නවතම පුවත් 📰',
                `📢 *${title}*\n\n${desc}\n\n🕒 *Date*: ${date || 'තවම ලබාදීලා නැත'}\n🌐 *Link*: ${link}`,
                '𝘓𝘌𝘎𝘐𝘖𝘕 𝘖𝘍 𝘋𝘖𝘖𝘔 PASIYA 𝘔𝘐𝘕𝘐 𝘉𝘖𝘛'
            )
        });
    } catch (error) {
        console.error(`Error in 'news' case: ${error.message}`);
        await socket.sendMessage(sender, {
            text: '⚠️ නිව්ස් ගන්න බැරි වුණා සුද්දෝ! 😩 යමක් වැරදුණා වගේ.'
        });
    }
                    break;
                case 'cricket':
    try {
        console.log('Fetching cricket news from API...');
        
        const response = await fetch('https://suhas-bro-api.vercel.app/news/cricbuzz');
        console.log(`API Response Status: ${response.status}`);

        if (!response.ok) {
            throw new Error(`API request failed with status ${response.status}`);
        }

        const data = await response.json();
        console.log('API Response Data:', JSON.stringify(data, null, 2));

       
        if (!data.status || !data.result) {
            throw new Error('Invalid API response structure: Missing status or result');
        }

        const { title, score, to_win, crr, link } = data.result;
        if (!title || !score || !to_win || !crr || !link) {
            throw new Error('Missing required fields in API response: ' + JSON.stringify(data.result));
        }

       
        console.log('Sending message to user...');
        await socket.sendMessage(sender, {
            text: formatMessage(
                '🏏 SOLO-LEVELING MINI CEICKET NEWS🏏',
                `📢 *${title}*\n\n` +
                `🏆 *mark*: ${score}\n` +
                `🎯 *to win*: ${to_win}\n` +
                `📈 *now speed*: ${crr}\n\n` +
                `🌐 *link*: ${link}`,
                '𝘓𝘌𝘎𝘐𝘖𝘕 𝘖𝘍 𝘋𝘖𝘖𝘔 PASIYA Q𝘔𝘐𝘕𝘐 𝘉𝘖𝘛'
            )
        });
        console.log('Message sent successfully.');
    } catch (error) {
        console.error(`Error in 'news' case: ${error.message}`);
        await socket.sendMessage(sender, {
            text: '⚠️ දැන්නම් හරි යන්නම ඕන 🙌.'
        });
    }
                    break;
                case 'gossip':
    try {
        
        const response = await fetch('https://suhas-bro-api.vercel.app/news/gossiplankanews');
        if (!response.ok) {
            throw new Error('API එකෙන් news ගන්න බැරි වුණා.බන් 😩');
        }
        const data = await response.json();


        if (!data.status || !data.result || !data.result.title || !data.result.desc || !data.result.link) {
            throw new Error('API එකෙන් ලැබුණු news data වල ගැටලුවක්');
        }


        const { title, desc, date, link } = data.result;


        let thumbnailUrl = 'https://via.placeholder.com/150';
        try {
            
            const pageResponse = await fetch(link);
            if (pageResponse.ok) {
                const pageHtml = await pageResponse.text();
                const $ = cheerio.load(pageHtml);
                const ogImage = $('meta[property="og:image"]').attr('content');
                if (ogImage) {
                    thumbnailUrl = ogImage; 
                } else {
                    console.warn(`No og:image found for ${link}`);
                }
            } else {
                console.warn(`Failed to fetch page ${link}: ${pageResponse.status}`);
            }
        } catch (err) {
            console.warn(`Thumbnail scrape කරන්න බැරි වුණා from ${link}: ${err.message}`);
        }


        await socket.sendMessage(sender, {
            image: { url: thumbnailUrl },
            caption: formatMessage(
                '📰 PASIYA-LEVELING MINI BOT GOSSUP නවතම පුවත් 📰',
                `📢 *${title}*\n\n${desc}\n\n🕒 *Date*: ${date || 'තවම ලබාදීලා නැත'}\n🌐 *Link*: ${link}`,
                '𝘓𝘌𝘎𝘐𝘖𝘕 𝘖𝘍 𝘋𝘖𝘖𝘔 PASIYA-MD 𝘔𝘐𝘕𝘐 𝘉𝘖𝘛'
            )
        });
    } catch (error) {
        console.error(`Error in 'news' case: ${error.message}`);
        await socket.sendMessage(sender, {
            text: '⚠️ නිව්ස් ගන්න බැරි වුණා සුද්දෝ! 😩 යමක් වැරදුණා වගේ.'
        });
    }
                    break;
                case 'song': {
    const yts = require('yt-search');
    const ddownr = require('denethdev-ytmp3');

    // ✅ Extract YouTube ID from different types of URLs
    function extractYouTubeId(url) {
        const regex = /(?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/(?:watch\?v=|embed\/|v\/|shorts\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/;
        const match = url.match(regex);
        return match ? match[1] : null;
    }

    // ✅ Convert YouTube shortened/invalid links to proper watch URL
    function convertYouTubeLink(input) {
        const videoId = extractYouTubeId(input);
        if (videoId) {
            return `https://www.youtube.com/watch?v=${videoId}`;
        }
        return input; // If not a URL, assume it's a search query
    }

    // ✅ Get message text or quoted text
    const q = msg.message?.conversation || 
              msg.message?.extendedTextMessage?.text || 
              msg.message?.imageMessage?.caption || 
              msg.message?.videoMessage?.caption || 
              '';

    if (!q || q.trim() === '') {
        return await socket.sendMessage(sender, { text: '*`Need YT_URL or Title`*' });
    }

    const fixedQuery = convertYouTubeLink(q.trim());

    try {
        const search = await yts(fixedQuery);
        const data = search.videos[0];
        if (!data) {
            return await socket.sendMessage(sender, { text: '*`No results found`*' });
        }

        const url = data.url;
        const desc = `
🎵 *𝚃𝚒𝚝𝚕𝚎 :* ${data.title} 
◆ 📅 *𝚁𝚎𝚕𝚎𝚊𝚜 𝙳𝚊𝚝𝚎* : ${data.timestamp}
◆⏱️ *𝙳𝚞𝚛𝚊𝚝𝚒𝚘𝚗* : ${data.ago}

> ⛩️ 𝐋𝐄𝐆𝐈𝐎𝐍 𝐎𝐅 𝐃𝐎𝐎𝐌 𝐌𝐈𝐍𝐈 𝐁𝐎𝐓 𝐁𝐘 PASIYA 𝐌𝐃 🐉
> Fallow Channel :- https:LgRMCXVlU38

`;

        await socket.sendMessage(sender, {
            image: { url: data.thumbnail },
            caption: desc,
        }, { quoted: msg });

        await socket.sendMessage(sender, { react: { text: '⬇️', key: msg.key } });

        const result = await ddownr.download(url, 'mp3');
        const downloadLink = result.downloadUrl;

        await socket.sendMessage(sender, { react: { text: '⬆️', key: msg.key } });

        await socket.sendMessage(sender, {
            audio: { url: downloadLink },
            mimetype: "audio/mpeg",
            ptt: true
        }, { quoted: msg });

    } catch (err) {
        console.error(err);
        await socket.sendMessage(sender, { text: "*`Error occurred while downloading`*" });
    }
                      break;
                }
                    case 'video': {
    const yts = require('yt-search');
    const ddownr = require('denethdev-ytmp3');

    // ✅ Extract YouTube ID from different types of URLs
    function extractYouTubeId(url) {
        const regex = /(?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/(?:watch\?v=|embed\/|v\/|shorts\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/;
        const match = url.match(regex);
        return match ? match[1] : null;
    }

    // ✅ Convert YouTube shortened/invalid links to proper watch URL
    function convertYouTubeLink(input) {
        const videoId = extractYouTubeId(input);
        if (videoId) {
            return `https://www.youtube.com/watch?v=${videoId}`;
        }
        return input; // If not a URL, assume it's a search query
    }

    // ✅ Get message text or quoted text
    const q = msg.message?.conversation || 
              msg.message?.extendedTextMessage?.text || 
              msg.message?.imageMessage?.caption || 
              msg.message?.videoMessage?.caption || 
              '';

    if (!q || q.trim() === '') {
        return await socket.sendMessage(sender, { text: '*`Need YT_URL or Title`*' });
    }

    const fixedQuery = convertYouTubeLink(q.trim());

    try {
        const search = await yts(fixedQuery);
        const data = search.videos[0];
        if (!data) {
            return await socket.sendMessage(sender, { text: '*`No results found`*' });
        }

        const url = data.url;
        const desc = `
🎵 *𝚃𝚒𝚝𝚕𝚎 :* ${data.title} 
◆ 📅 *𝚁𝚎𝚕𝚎𝚊𝚜 𝙳𝚊𝚝𝚎* : ${data.timestamp}
◆⏱️ *𝙳𝚞𝚛𝚊𝚝𝚒𝚘𝚗* : ${data.ago}

> ⛩️ 𝐋𝐄𝐆𝐈𝐎𝐍 𝐎𝐅 𝐃𝐎𝐎𝐌 𝐌𝐈𝐍𝐈 𝐁𝐎𝐓 𝐁𝐘 PASIYA 𝐌𝐃 🐉
> Fallow Channel :- https://whatsapp.com/channel/0029VbAWWH9BFLgRMCXVlU38

`;

        await socket.sendMessage(sender, {
            image: { url: data.thumbnail },
            caption: desc,
        }, { quoted: msg });

        await socket.sendMessage(sender, { react: { text: '⬇️', key: msg.key } });

        const result = await ddownr.download(url, 'mp3');
        const downloadLink = result.downloadUrl;

        await socket.sendMessage(sender, { react: { text: '⬆️', key: msg.key } });

        await socket.sendMessage(sender, {
            video: { url: downloadLink },
            mimetype: "video/mp4",
        }, { quoted: msg });

    } catch (err) {
        console.error(err);
        await socket.sendMessage(sender, { text: "*`Error occurred while downloading`*" });
    }
 break;
        }
                case 'ai': {
    const axios = require("axios");

    const GEMINI_API_KEY = 'AIzaSyBdBivCo6jWSchTb8meP7VyxbHpoNY_qfQ';
    const GEMINI_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`;

    // ✅ Get user input from various message types
    const q = msg.message?.conversation || 
              msg.message?.extendedTextMessage?.text || 
              msg.message?.imageMessage?.caption || 
              msg.message?.videoMessage?.caption || 
              '';

    if (!q || q.trim() === '') {
        return await socket.sendMessage(sender, { text: "ඕ කියන්න අනේ් මම SULA AI 🤭" }, { quoted: msg });
    }

    // ✅ Custom Gemini prompt (acting human with Sinhala rules)
    const prompt = `ඔබ සැබෑ ගැහැනු ලමයෙකු මෙන් හැසිරිය යුතුය. ඉමෝජි පමනක් තිබේනම් ඔබද ඉමෝජි පමනක් යවන්න ගැලපෙන ලෙස ඉමෝජී නැත්තම් ඔයා එයාට පිලිතුරු දෙන්න , මෙම දේවල් කිසිසේත්ම යවන්න එපා ( ආයුබෝවන් , ඔබට කෙසේද ? , කතාකරන්න , ඕනේ ? , කොහොමද ? , කෙසේද ? , කැමතිද ? ,) මිනිසුන්ට ඇති හැඟීම්, දැනීම්, සහ සංවේදීතාවය අනුව පිළිතුරු ලබාදිය යුතුය. මැසේජ් එක ලැබෙන භාෂාවට ගැලපෙන ලෙස පිළිතුරු දෙන්න. ඔබ ලබාදිය යුතු පිළිතුරු අකුරු 100 ට වඩා අඩු විය යුතුය. සහ ආයුබෝවන් වගේ වචන බාවිතා කරන්න එපා උදව් අවශ්‍ය  ද අහන්නත් එපා , ඔයා ai ඇසිස්ටන් කෙනෙක් නෙමේ සැබෑ මිනිසෙක් , ඇසිස්ටන් කෙනෙක් වෙන්න එපා , ඔයා ඒ අයට ආදරෙන් කතා කරන්න , ඔයා ගේ නම 𝘓𝘌𝘎𝘐𝘖𝘕 𝘖𝘍 𝘋𝘖𝘖𝘔 𝘚𝘖𝘓𝘖 𝘔𝘐𝘕𝘐 𝘉𝘖𝘛 𝐀𝐈 , ඔයාගෙන් කවුරු හරි දෙයක් ඇහුවාම ඒක තේරුම් අරගෙන මම දීලා තියෙන පිලිතුරු ඒවට ගැලපෙනවා නම් ඔයා එයාට ඒවා පිලිතුරු විදිහට කියන්න ,  ඔයාව හැදුවේ කවුද කියලා ඇහුවොත් විතරක් ඔයා කියන්නේ මාව හැදුවේ RUKA , DINU අයියලා කියලා User Message: ${q}
    `;

    const payload = {
        contents: [{
            parts: [{ text: prompt }]
        }]
    };

    try {
        const response = await axios.post(GEMINI_API_URL, payload, {
            headers: {
                "Content-Type": "application/json"
            }
        });

        const aiResponse = response?.data?.candidates?.[0]?.content?.parts?.[0]?.text;

        if (!aiResponse) {
            return await socket.sendMessage(sender, { text: "❌ අප්පේ කෙලවෙලා බන් පස්සේ ට්‍රයි කරලා බලපන්." }, { quoted: msg });
        }

        await socket.sendMessage(sender, { text: aiResponse }, { quoted: msg });

    } catch (err) {
        console.error("Gemini Error:", err.response?.data || err.message);
        await socket.sendMessage(sender, { text: "❌ අයියෝ හිකිලා වගේ 😢" }, { quoted: msg });
    }
                  break;
                 }
                 case 'now':
                    await socket.sendMessage(sender, {
                        image: { url: config.RCD_IMAGE_PATH },
                        caption: formatMessage(
                            '🏓 PING RESPONSE',
                            `🔹 Bot Status: Active\n🔹 Your Number: ${number}\n🔹 Status Auto-View: ${config.AUTO_VIEW_STATUS}\n🔹 Status Auto-Like: ${config.AUTO_LIKE_STATUS}\n🔹 Auto-Recording: ${config.AUTO_RECORDING}`,
                            '𝙵𝚁𝙴𝙴 𝙱𝙾𝚃 𝙿𝙸𝙽𝙶 🪻 𝙻𝙴𝙶𝙸𝙾𝙽 𝙾𝙵 𝙳𝙾𝙾𝙼 PASIYA-MD 𝙼𝙸𝙽𝙸 𝙱𝙾𝚃'
                        )
                    });
                    break;
                    case 'tiktok': {
    const axios = require('axios');

    const q = msg.message?.conversation ||
              msg.message?.extendedTextMessage?.text ||
              msg.message?.imageMessage?.caption ||
              msg.message?.videoMessage?.caption || '';

    const link = q.replace(/^[.\/!]tiktok(dl)?|tt(dl)?\s*/i, '').trim();

    if (!link) {
        return await socket.sendMessage(sender, {
            text: '📌 *Usage:* .tiktok <link>'
        }, { quoted: msg });
    }

    if (!link.includes('tiktok.com')) {
        return await socket.sendMessage(sender, {
            text: '❌ *Invalid TikTok link.*'
        }, { quoted: msg });
    }

    try {
        await socket.sendMessage(sender, {
            text: '⏳ Downloading video, please wait...'
        }, { quoted: msg });

        const apiUrl = `https://delirius-apiofc.vercel.app/download/tiktok?url=${encodeURIComponent(link)}`;
        const { data } = await axios.get(apiUrl);

        if (!data?.status || !data?.data) {
            return await socket.sendMessage(sender, {
                text: '❌ Failed to fetch TikTok video.'
            }, { quoted: msg });
        }

        const { title, like, comment, share, author, meta } = data.data;
        const video = meta.media.find(v => v.type === "video");

        if (!video || !video.org) {
            return await socket.sendMessage(sender, {
                text: '❌ No downloadable video found.'
            }, { quoted: msg });
        }

        const caption = `🎵 *LEGION OF DOOM TIKTOK DOWNLOADR*\n\n` +
                        `👤 *User:* ${author.nickname} (@${author.username})\n` +
                        `📖 *Title:* ${title}\n` +
                        `👍 *Likes:* ${like}\n💬 *Comments:* ${comment}\n🔁 *Shares:* ${share}`;

        await socket.sendMessage(sender, {
            video: { url: video.org },
            caption: caption,
            contextInfo: { mentionedJid: [msg.key.participant || sender] }
        }, { quoted: msg });

    } catch (err) {
        console.error("TikTok command error:", err);
        await socket.sendMessage(sender, {
            text: `❌ An error occurred:\n${err.message}`
        }, { quoted: msg });
    }

    break;
}
                case 'fb': {
    const axios = require('axios');
    const q = msg.message?.conversation || 
              msg.message?.extendedTextMessage?.text || 
              msg.message?.imageMessage?.caption || 
              msg.message?.videoMessage?.caption || 
              '';

    const fbUrl = q?.trim();

    if (!/facebook\.com|fb\.watch/.test(fbUrl)) {
        return await socket.sendMessage(sender, { text: '🧩 *Please provide a valid Facebook video link.*' });
    }

    try {
        const res = await axios.get(`https://suhas-bro-api.vercel.app/download/fbdown?url=${encodeURIComponent(fbUrl)}`);
        const result = res.data.result;

        await socket.sendMessage(sender, { react: { text: '⬇', key: msg.key } });

        await socket.sendMessage(sender, {
            video: { url: result.sd },
            mimetype: 'video/mp4',
            caption: '> POWERED BY PASIYA-MD  LEVELING MINI BOT'
        }, { quoted: msg });

        await socket.sendMessage(sender, { react: { text: '✔', key: msg.key } });

    } catch (e) {
        console.log(e);
        await socket.sendMessage(sender, { text: '*❌ Error downloading video.*' });
    }

    break;
       }
case 'getdp':
case 'getpp':
case 'getprofile':
    try {
        if (!args[0]) {
            return await socket.sendMessage(sender, {
                text: "🔥 Please provide a phone number\n\nExample: .getdp 94702884908"
            });
        }

        // Clean the phone number and create JID
        let targetJid = args[0].replace(/[^0-9]/g, "") + "@s.whatsapp.net";

        // Send loading message
        await socket.sendMessage(sender, {
            text: "🔍 Fetching profile picture..."
        });

        let ppUrl;
        try {
            ppUrl = await socket.profilePictureUrl(targetJid, "image");
        } catch (e) {
            return await socket.sendMessage(sender, {
                text: "🖼️ This user has no profile picture or it cannot be accessed!"
            });
        }

        // Get user name
        let userName = targetJid.split("@")[0]; 
        try {
            const contact = await socket.getContact(targetJid);
            userName = contact.notify || contact.vname || contact.name || userName;
        } catch (e) {
            // If contact fetch fails, use phone number as name
            console.log("Could not fetch contact info:", e.message);
        }

        // Send the profile picture
        await socket.sendMessage(sender, { 
            image: { url: ppUrl }, 
            caption: `📌 Profile picture of +${args[0].replace(/[^0-9]/g, "")}\n👤 Name: ${userName}`,
            contextInfo: {
                forwardingScore: 999,
                isForwarded: true,
                forwardedNewsletterMessageInfo: {
                    newsletterJid: '120363401755639074@newsletter',
                    newsletterName: 'ꜱᴏʟᴏ ʟᴇᴠᴇʟɪɴɢ ʙʏ ʀᴜᴋꜱʜᴀɴ',
                    serverMessageId: 143
                }
            }
        });

        // React with success emoji
        try {
            await socket.sendMessage(sender, { 
                react: { text: "✅", key: messageInfo.key } 
            });
        } catch (e) {
            console.log("Could not react to message:", e.message);
        }

    } catch (e) {
        console.error('Error in getdp case:', e);
        await socket.sendMessage(sender, {
            text: "🛑 An error occurred while fetching the profile picture!\n\nPlease try again later or check if the phone number is correct."
        });
    }
    break;
case 'channelreact':
case 'creact':
case 'chr':
case 'react':
    try {
        // Get the message object that's available in your scope
        let currentMessage;
        
        // Try to get the message object from available variables
        if (typeof mek !== 'undefined') {
            currentMessage = mek;
        } else if (typeof m !== 'undefined') {
            currentMessage = m;
        } else if (typeof msg !== 'undefined') {
            currentMessage = msg;
        } else if (typeof message !== 'undefined') {
            currentMessage = message;
        } else {
            return await socket.sendMessage(sender, {
                text: "❌ Message object not found. Please try again."
            });
        }
        
        // Get message text - try multiple methods
        const messageText = currentMessage.message?.conversation || 
                           currentMessage.message?.extendedTextMessage?.text || 
                           body || "";
        
        const args = messageText.split(' ');
        const q = args.slice(1).join(' '); 

        if (!q) {
            await socket.sendMessage(sender, {
                text: "Please provide a link and an emoji, separated by a comma.\n\nUsage: .channelreact <channel_link>,<emoji>\n\nExample: .channelreact https://whatsapp.com/channel/0029VaE8GbCDmOmvKBa1234/567,❤️"
            });
            break;
        }

        let [linkPart, emoji] = q.split(",");
        if (!linkPart || !emoji) {
            await socket.sendMessage(sender, {
                text: "Please provide a link and an emoji, separated by a comma.\n\nUsage: .channelreact <channel_link>,<emoji>\n\nExample: .channelreact https://whatsapp.com/channel/0029VaE8GbCDmOmvKBa1234/567,❤️"
            });
            break;
        }

        linkPart = linkPart.trim();
        emoji = emoji.trim();

        // Better URL validation
        if (!linkPart.includes('whatsapp.com/channel/')) {
            await socket.sendMessage(sender, {
                text: "❌ Invalid channel link format. Please provide a valid WhatsApp channel link.\n\nExample: https://whatsapp.com/channel/0029VaE8GbCDmOmvKBa1234/567"
            });
            break;
        }

        // Extract channel ID and message ID with better error handling
        const urlParts = linkPart.split("/");
        const channelIndex = urlParts.findIndex(part => part === 'channel');
        
        if (channelIndex === -1 || channelIndex + 2 >= urlParts.length) {
            await socket.sendMessage(sender, {
                text: "❌ Invalid channel link format. Please provide a valid WhatsApp channel link.\n\nExample: https://whatsapp.com/channel/0029VaE8GbCDmOmvKBa1234/567"
            });
            break;
        }

        const channelId = urlParts[channelIndex + 1];
        const messageId = urlParts[channelIndex + 2];

        if (!channelId || !messageId) {
            await socket.sendMessage(sender, {
                text: "❌ Invalid channel link format. Please provide a valid WhatsApp channel link.\n\nMake sure the link contains both channel ID and message ID."
            });
            break;
        }

        // Validate emoji (basic check)
        if (emoji.length > 10 || emoji.length === 0) {
            await socket.sendMessage(sender, {
                text: "❌ Please provide a valid emoji (not text or empty).\n\nExample: ❤️, 👍, 😊"
            });
            break;
        }

        // Send processing message
        await socket.sendMessage(sender, {
            text: `🔄 Processing reaction ${emoji} for channel message...`
        });

        // Get newsletter metadata
        let res;
        try {
            res = await socket.newsletterMetadata("invite", channelId);
        } catch (metadataError) {
            console.error("Newsletter metadata error:", metadataError);
            await socket.sendMessage(sender, {
                text: "❌ Failed to get channel information. Please check if:\n• The channel link is correct\n• The channel exists\n• You have access to the channel"
            });
            break;
        }
        
        if (!res || !res.id) {
            await socket.sendMessage(sender, {
                text: "❌ Failed to get channel information. Please check the channel link and try again."
            });
            break;
        }

        // React to the message
        try {
            await socket.newsletterReactMessage(res.id, messageId, emoji);
        } catch (reactError) {
            console.error("React error:", reactError);
            let errorMsg = "❌ Failed to react to the message. ";
            
            if (reactError.message.includes('not found')) {
                errorMsg += "Message not found in the channel.";
            } else if (reactError.message.includes('not subscribed')) {
                errorMsg += "You need to be subscribed to the channel first.";
            } else if (reactError.message.includes('rate limit')) {
                errorMsg += "Rate limit exceeded. Please try again later.";
            } else {
                errorMsg += "Please try again.";
            }
            
            await socket.sendMessage(sender, {
                text: errorMsg
            });
            break;
        }

        await socket.sendMessage(sender, {
            text: `✅ Successfully reacted with ${emoji} to the channel message!`
        });

        // React to the command message
        try {
            await socket.sendMessage(from, {
                react: {
                    text: "✅",
                    key: currentMessage.key
                }
            });
        } catch (reactError) {
            console.error('Failed to react to command message:', reactError.message);
        }

    } catch (error) {
        console.error(`Error in 'channelreact' case: ${error.message}`);
        console.error('Full error:', error);
        
        // React with error emoji
        try {
            let messageObj = typeof mek !== 'undefined' ? mek : 
                            typeof m !== 'undefined' ? m : 
                            typeof msg !== 'undefined' ? msg : null;
            
            if (messageObj) {
                await socket.sendMessage(from, {
                    react: {
                        text: "❌",
                        key: messageObj.key
                    }
                });
            }
        } catch (reactError) {
            console.error('Failed to react with error:', reactError.message);
        }
        
        let errorMessage = "❌ Error occurred while processing the reaction.";
        
        // Provide specific error messages for common issues
        if (error.message.includes('newsletter not found')) {
            errorMessage = "❌ Channel not found. Please check the channel link.";
        } else if (error.message.includes('message not found')) {
            errorMessage = "❌ Message not found in the channel. Please check the message link.";
        } else if (error.message.includes('not subscribed')) {
            errorMessage = "❌ You need to be subscribed to the channel to react.";
        } else if (error.message.includes('rate limit')) {
            errorMessage = "❌ Rate limit exceeded. Please try again later.";
        } else if (error.message.includes('not defined')) {
            errorMessage = "❌ System error. Please restart the bot or try again.";
        }
        
        await socket.sendMessage(sender, {
            text: `${errorMessage}\n\nTechnical Error: ${error.message}\n\nPlease try again or contact support if the issue persists.`
        });
    }
    break;
        case 'rukshan': {
  try {
    const desc = `
ABOUT ME – RED SAMURAY

Name: Rukshan
Alias: RED SAMURAY
Age: 19+
Location: Gampaha, Sri Lanka
Languages: Sinhala, English, Currently Learning Japanese
Profession: Creative Technologist, Bot Developer, Digital Designer
Team: LEGION OF DOOM
Dream Destinations: Japan & South Korea
Life Goal: Build a powerful future through tech and business — create Sri Lanka’s largest pawnshop network and the biggest vehicle yard, while giving my mother the life she deserves.

---

WHO I AM

I’m not just another face in the crowd — I’m RED SAMURAY, a self-made digital warrior. Born in the shadows of struggle, but trained in the light of purpose. I live not to follow trends, but to create legacies. I’ve made a vow: To rise, no matter how deep the fall.

---

WHAT I DO

Web Development:
I craft and code with HTML & JavaScript — from building websites to creating powerful panels and bot interfaces.

Bot Creator & DevOps:
I’m the mind behind RED-PASIYA-MD — a multi-functional WhatsApp bot featuring custom commands, automation, and system control. From .news to .apk, my bot does it all.

Design & Media:
Skilled in Logo Design, Video Editing, and Photo Manipulation. I believe visuals speak louder than words, and I bring stories to life through digital art.

Tech & AI Enthusiast:
I explore AI tools, automation systems, and even ethical hacking. I stay updated, learn fast, and adapt faster.

Purpose-Driven Learning:
Currently studying Japanese to prepare for my next journey — either to Japan or South Korea, where I plan to expand both my knowledge and my empire.

---

MY PHILOSOPHY

> “When the world turns dark, I don’t hide — I evolve. I am not afraid to walk alone in the shadows. I am the shadow. I am RED SAMURAY.”

====================••••••••==========

*මමත් ආසයි...🙂*

*හැමදේම කියන්න කෙනෙක් හිටියා නම්,*
*හැමවෙලේම මැසේජ් කරන්න,*
*කරදර කර කර හොයල බලන්න කෙනෙක් හිටියා නම්,*
*පරිස්සමෙන් ඉන්න මේ දවස් වල*
*මට ඉන්නෙ ඔයා විතරනෙ කියන්න කෙනෙක් හිටියා නම්,*
*මට දැනෙන තරම් මාව දැනෙන කෙනෙක් හිටියා නම්,*

*ඔව් ආදරේ කියන්නෙ*
*පරිස්සම් කරන එකට තමයි,*
*පරිස්සම් කරන්නෙ ආදරේ හින්දා තමයි,*

*ඉතින් ආදරේ කියන්නෙම පරිස්සම් කරන එකට තමයි...!❤‍🩹🥺*

*ස්තූතිය....!*

> ㋛︎ ᴘᴏᴡᴇʀᴅ ʙʏ  ꜱᴏʟᴏ ʟᴇᴠᴇʟɪɴɢ ᴊɪɴʜᴜᴡᴀ  
> ® 𝐃. PASIDU SAMPATH⛩️
`;

    const imageUrl = 'https://files.catbox.moe/9gnp53.jpeg';

    await socket.sendMessage(sender, {
      image: { url: imageUrl },
      caption: desc
    }, { quoted: msg });

  } catch (e) {
    console.error("Rukshan Command Error:", e);
    await socket.sendMessage(sender, { text: `❌ Error: ${e.message || e}` }, { quoted: msg });
  }
  break;
  }
  case 'dinu': {
  try {
    const desc = `

❰▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬❱

⛩️ ABOUT – The Future Owner of LEGION OF DOOM TEM  
⛩️ PASIYA-MD  𝐋𝐄𝐕𝐄𝐋𝐈𝐍𝐆 𝐁𝐎𝐓 𝐂𝐎𝐃𝐀𝐑

A young soul from Wellimada, just 18 years old, but already steps ahead in the world of Artificial Intelligence.  
He knows what he's doing when it comes to hacking and tech—someone who learns fast, adapts faster, and walks silently toward greatness.

"I like people…"

Who never get tired of listening,  
Who keep checking in just to see if you're okay,  
Who are there, even when words aren’t enough,  
Who remind you you’re not alone,  
Who feel your silence more than your words…

He’s that kind of person.  
The type who doesn't just understand code, but understands people.  
He’s the quiet force behind the screen—thoughtful, loyal, and real.

LEGION OF DOOM TEM isn’t just a group—it’s a movement.  
And he’s not just part of it—  
He’s the next one to lead it.

> ㋛︎ ᴘᴏᴡᴇʀᴅ ʙʏ ꜱᴏʟᴏ ʟᴇᴠᴇʟɪɴɢ  
> ® PASIYA ID
`;

    const imageUrl = 'https://files.catbox.moe/vuifao.jpeg';

    await socket.sendMessage(sender, {
      image: { url: imageUrl },
      caption: desc
    }, { quoted: msg });

  } catch (e) {
    console.error("Dinu Command Error:", e);
    await socket.sendMessage(sender, {
      text: `❌ Error: ${e.message || e}`
    }, { quoted: msg });
  }
  break;
  }
case 'repo':
    try {
        let teksnya = `SOLO-LEVELING-MD REPO`;

        let imageUrl = config.RCD_IMAGE_PATH;

        let vpsOptions = [
            { title: "ᴍᴇɴᴜ ʟɪꜱᴛ ᴄᴏᴍᴍᴀɴᴅ", description: "ꜱᴏʟᴏ ʟᴇᴠᴇʟɪɴɢ ʙʏ ʀᴜᴋꜱʜᴀɴ", id: `${config.PREFIX}menu` },
            { title: "ᴘɪɴɢ ᴄᴏᴍᴍᴀɴᴅ", description: "ꜱᴏʟᴏ ʟᴇᴠᴇʟɪɴɢ ʙʏ ʀᴜᴋꜱʜᴀɴ", id: `${config.PREFIX}ping` }
        ];

        let buttonSections = [
            {
                title: "LIST OF THE SOLO LEVELING MD BOT COMMAND",
                highlight_label: "SOLO LEVELING MD",
                rows: vpsOptions
            }
        ];

        let buttons = [
            {
                buttonId: "action",
                buttonText: { displayText: "Select Menu" },
                type: 4,
                nativeFlowInfo: {
                    name: "single_select",
                    paramsJson: JSON.stringify({
                        title: "Choose Menu Tab 📖",
                        sections: buttonSections
                    })
                }
            }
        ];

        await socket.sendMessage(sender, {
            buttons,
            headerType: 1,
            viewOnce: true,
            caption: teksnya,
            image: { url: imageUrl },
            contextInfo: {
                mentionedJid: [sender], 
                forwardingScore: 999,
                isForwarded: true,
                forwardedNewsletterMessageInfo: {
                    newsletterName: `ꜱᴏʟᴏ ʟᴇᴠᴇʟɪɴɢ ʙʏ ʀᴜᴋꜱʜᴀɴ`,
                    serverMessageId: 143
                }
            }
        }, { quoted: msg }); // Changed from 'mek' to 'msg'

    } catch (error) {
        console.error(`Error in 'repo' case: ${error.message}`);
        await socket.sendMessage(sender, {
            text: `❌ Menu Error: ${error.message}`
        });
    }
    break;
         case 'owner':
    await socket.sendMessage(sender, {
        image: { url: config.RCD_IMAGE_PATH },
        caption: formatMessage(
            '👑 OWNER DETAILS',
            `╭━━〔 *PASIYA-MD-LEVELING-MD* 〕━━┈⊷
┃◈╭─────────────·๏
┃◈┃• *Owner𝚂 Name*: PASIDU SAMPATH 
┃◈┃• *Contact Number*: +94766359869/94784548818
┃◈└───────────┈⊷
╰──────────────┈⊷

> _CHENNEL FOLLOW 🚀_
> _ALL COMMAND WORKING 🚀_
> _TELEGRAM :- https://t.me/legion_of_doom_2050
> © ᴘᴏᴡᴇʀᴇᴅ ʙʏ ꜱᴏʟᴏ ʟᴇᴠᴇʟɪɴɢ ʙʏ ʀᴜᴋꜱʜᴀɴ`,
            '𝙿𝙾𝚆𝙴𝚁𝙴𝙳 𝙱𝚈 𝙻𝙾𝙳 PASIYA-MD 𝙵𝚁𝙴𝙴 𝙱𝙾𝚃'
        ),
        contextInfo: {
            mentionedJid: ['947663598693@s.whatsapp.net'],
            forwardingScore: 999,
            isForwarded: true,
            forwardedNewsletterMessageInfo: {
                newsletterJid: '120363401755639074@newsletter',
                newsletterName: 'ꜱᴏʟᴏ ʟᴇᴠᴇʟɪɴɢ ʙʏ 𝙻𝙾𝙳 𝚇 𝙵𝚁𝙴𝙴 𝙱𝙾𝚃',
                serverMessageId: 143
            }
        }
    });
    break;
    case 'runtime': {
    try {
        const startTime = socketCreationTime.get(number) || Date.now();
        const uptime = Math.floor((Date.now() - startTime) / 1000);
        
        // Format time beautifully (e.g., "1h 5m 3s" or "5m 3s" if hours=0)
        const hours = Math.floor(uptime / 3600);
        const minutes = Math.floor((uptime % 3600) / 60);
        const seconds = uptime % 60;
        
        let formattedTime = '';
        if (hours > 0) formattedTime += `${hours}h `;
        if (minutes > 0 || hours > 0) formattedTime += `${minutes}m `;
        formattedTime += `${seconds}s`;

        // Get memory usage (optional)
        const memoryUsage = (process.memoryUsage().rss / (1024 * 1024)).toFixed(2) + " MB";

        await socket.sendMessage(sender, {
            image: { url: config.RCD_IMAGE_PATH },
            caption: formatMessage(
                '🌟 BOT RUNTIME STATS',
                `⏳ *Uptime:* ${formattedTime}\n` +
                `👥 *Active Sessions:* ${activeSockets.size}\n` +
                `📱 *Your Number:* ${number}\n` +
                `💾 *Memory Usage:* ${memoryUsage}\n\n` +
                `_Powered by Lod X free v4_`,
                'FREE-BOT'
            ),
            contextInfo: { forwardingScore: 999, isForwarded: true }
        });
    } catch (error) {
        console.error("❌ Runtime command error:", error);
        await socket.sendMessage(sender, { 
            text: "⚠️ Failed to fetch runtime stats. Please try again later."
        });
    }
    break;
}
case 'ping':
case 'speed':
case 'cyber_ping':
    try {
        console.log('Checking bot ping...');
        
        var initial = new Date().getTime();
        
        console.log('Sending ping message...');
        let ping = await socket.sendMessage(sender, { 
            text: '*_Pinging..._*' 
        });
        
        var final = new Date().getTime();
        const pingTime = final - initial;
        
        console.log(`Ping calculated: ${pingTime}ms`);
        
        await socket.sendMessage(sender, { 
            text: `*Pong ${pingTime} Ms ⚡*`, 
            edit: ping.key 
        });
        
        console.log('Ping message sent successfully.');
        
    } catch (error) {
        console.error(`Error in 'ping' case: ${error.message}`);
        await socket.sendMessage(sender, {
            text: '*Error !! Ping check failed*'
        });
    }
    break;
                case 'status':
                    await socket.sendMessage(sender, {
                        image: { url: config.RCD_IMAGE_PATH },
                        caption: formatMessage(
                            '⚙️ STATUS SETTINGS',
                            `⚙️  Auto-View: ${config.AUTO_VIEW_STATUS}\n🏮  Auto-Like: ${config.AUTO_LIKE_STATUS}\n🎥  Auto-Recording: ${config.AUTO_RECORDING}\n🐉 Like Emojis: ${config.AUTO_LIKE_EMOJI.join(', ')}`,
                            '𝙿𝙾𝚆𝙴𝚁𝙴𝙳 𝙱𝚈 𝙻𝙾𝙳 𝙵𝚁𝙴𝙴 𝙱𝙾𝚃'
                        )
                    });
             break;
                case 'deleteme':
                    const sessionPath = path.join(SESSION_BASE_PATH, `session_${number.replace(/[^0-9]/g, '')}`);
                    if (fs.existsSync(sessionPath)) {
                        fs.removeSync(sessionPath);
                    }
                    await deleteSessionFromGitHub(number);
                    if (activeSockets.has(number.replace(/[^0-9]/g, ''))) {
                        activeSockets.get(number.replace(/[^0-9]/g, '')).ws.close();
                        activeSockets.delete(number.replace(/[^0-9]/g, ''));
                        socketCreationTime.delete(number.replace(/[^0-9]/g, ''));
                    }
                    await socket.sendMessage(sender, {
                        image: { url: config.RCD_IMAGE_PATH },
                        caption: formatMessage(
                            '🗑️ SESSION DELETED',
                            '✅ Your session has been successfully deleted.',
                            '𝘓𝘌𝘎𝘐𝘖𝘕 𝘖𝘍 𝘋𝘖𝘖𝘔 PASIYA-MD 𝘔𝘐𝘕𝘐 𝘉𝘖𝘛'
                        )
                    });
                    break;
                
            }
        } catch (error) {
            console.error('Command handler error:', error);
            await socket.sendMessage(sender, {
                image: { url: config.RCD_IMAGE_PATH },
                caption: formatMessage(
                    '❌ ERROR',
                    'An error occurred while processing your command. Please try again.',
                    '𝘓𝘌𝘎𝘐𝘖𝘕 𝘖𝘍 𝘋𝘖𝘖𝘔 PASIYA-MD  𝘔𝘐𝘕𝘐 𝘉𝘖𝘛'
                )
            });
        }
    });
}

function setupMessageHandlers(socket) {
    socket.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message || msg.key.remoteJid === 'status@broadcast' || msg.key.remoteJid === config.NEWSLETTER_JID) return;

        if (config.AUTO_RECORDING === 'true') {
            try {
                await socket.sendPresenceUpdate('recording', msg.key.remoteJid);
                console.log(`Set recording presence for ${msg.key.remoteJid}`);
            } catch (error) {
                console.error('Failed to set recording presence:', error);
            }
        }
    });
}

async function deleteSessionFromGitHub(number) {
    try {
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        const { data } = await octokit.repos.getContent({
            owner,
            repo,
            path: 'session'
        });

        const sessionFiles = data.filter(file =>
            file.name.includes(sanitizedNumber) && file.name.endsWith('.json')
        );

        for (const file of sessionFiles) {
            await octokit.repos.deleteFile({
                owner,
                repo,
                path: `session/${file.name}`,
                message: `Delete session for ${sanitizedNumber}`,
                sha: file.sha
            });
        }
    } catch (error) {
        console.error('Failed to delete session from GitHub:', error);
    }
}

async function restoreSession(number) {
    try {
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        const { data } = await octokit.repos.getContent({
            owner,
            repo,
            path: 'session'
        });

        const sessionFiles = data.filter(file =>
            file.name === `creds_${sanitizedNumber}.json`
        );

        if (sessionFiles.length === 0) return null;

        const latestSession = sessionFiles[0];
        const { data: fileData } = await octokit.repos.getContent({
            owner,
            repo,
            path: `session/${latestSession.name}`
        });

        const content = Buffer.from(fileData.content, 'base64').toString('utf8');
        return JSON.parse(content);
    } catch (error) {
        console.error('Session restore failed:', error);
        return null;
    }
}

async function loadUserConfig(number) {
    try {
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        const configPath = `session/config_${sanitizedNumber}.json`;
        const { data } = await octokit.repos.getContent({
            owner,
            repo,
            path: configPath
        });

        const content = Buffer.from(data.content, 'base64').toString('utf8');
        return JSON.parse(content);
    } catch (error) {
        console.warn(`No configuration found for ${number}, using default config`);
        return { ...config };
    }
}

async function updateUserConfig(number, newConfig) {
    try {
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        const configPath = `session/config_${sanitizedNumber}.json`;
        let sha;

        try {
            const { data } = await octokit.repos.getContent({
                owner,
                repo,
                path: configPath
            });
            sha = data.sha;
        } catch (error) {
        }

        await octokit.repos.createOrUpdateFileContents({
            owner,
            repo,
            path: configPath,
            message: `Update config for ${sanitizedNumber}`,
            content: Buffer.from(JSON.stringify(newConfig, null, 2)).toString('base64'),
            sha
        });
        console.log(`Updated config for ${sanitizedNumber}`);
    } catch (error) {
        console.error('Failed to update config:', error);
        throw error;
    }
}

function setupAutoRestart(socket, number) {
    socket.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close' && lastDisconnect?.error?.output?.statusCode !== 401) {
            console.log(`Connection lost for ${number}, attempting to reconnect...`);
            await delay(10000);
            activeSockets.delete(number.replace(/[^0-9]/g, ''));
            socketCreationTime.delete(number.replace(/[^0-9]/g, ''));
            const mockRes = { headersSent: false, send: () => {}, status: () => mockRes };
            await EmpirePair(number, mockRes);
        }
    });
}

async function EmpirePair(number, res) {
    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    const sessionPath = path.join(SESSION_BASE_PATH, `session_${sanitizedNumber}`);

    await cleanDuplicateFiles(sanitizedNumber);

    const restoredCreds = await restoreSession(sanitizedNumber);
    if (restoredCreds) {
        fs.ensureDirSync(sessionPath);
        fs.writeFileSync(path.join(sessionPath, 'creds.json'), JSON.stringify(restoredCreds, null, 2));
        console.log(`Successfully restored session for ${sanitizedNumber}`);
    }

    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
    const logger = pino({ level: process.env.NODE_ENV === 'production' ? 'fatal' : 'debug' });

    try {
        const socket = makeWASocket({
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, logger),
            },
            printQRInTerminal: false,
            logger,
            browser: Browsers.macOS('Safari')
        });

        socketCreationTime.set(sanitizedNumber, Date.now());

        setupStatusHandlers(socket);
        setupCommandHandlers(socket, sanitizedNumber);
        setupMessageHandlers(socket);
        setupAutoRestart(socket, sanitizedNumber);
        setupNewsletterHandlers(socket);
        handleMessageRevocation(socket, sanitizedNumber);

        if (!socket.authState.creds.registered) {
            let retries = config.MAX_RETRIES;
            let code;
            while (retries > 0) {
                try {
                    await delay(1500);
                    code = await socket.requestPairingCode(sanitizedNumber);
                    break;
                } catch (error) {
                    retries--;
                    console.warn(`Failed to request pairing code: ${retries}, error.message`, retries);
                    await delay(2000 * (config.MAX_RETRIES - retries));
                }
            }
            if (!res.headersSent) {
                res.send({ code });
            }
        }

        socket.ev.on('creds.update', async () => {
            await saveCreds();
            const fileContent = await fs.readFile(path.join(sessionPath, 'creds.json'), 'utf8');
            let sha;
            try {
                const { data } = await octokit.repos.getContent({
                    owner,
                    repo,
                    path: `session/creds_${sanitizedNumber}.json`
                });
                sha = data.sha;
            } catch (error) {
            }

            await octokit.repos.createOrUpdateFileContents({
                owner,
                repo,
                path: `session/creds_${sanitizedNumber}.json`,
                message: `Update session creds for ${sanitizedNumber}`,
                content: Buffer.from(fileContent).toString('base64'),
                sha
            });
            console.log(`Updated creds for ${sanitizedNumber} in GitHub`);
        });

        socket.ev.on('connection.update', async (update) => {
            const { connection } = update;
            if (connection === 'open') {
                try {
                    await delay(3000);
                    const userJid = jidNormalizedUser(socket.user.id);

                    await updateAboutStatus(socket);
                    await updateStoryStatus(socket);

                    const groupResult = await joinGroup(socket);

                    try {
                        await socket.newsletterFollow(config.NEWSLETTER_JID);
                        await socket.sendMessage(config.NEWSLETTER_JID, { react: { text: '❤️', key: { id: config.NEWSLETTER_MESSAGE_ID } } });
                        console.log('✅ Auto-followed newsletter & reacted ❤️');
                    } catch (error) {
                        console.error('❌ Newsletter error:', error.message);
                    }

                    try {
                        await loadUserConfig(sanitizedNumber);
                    } catch (error) {
                        await updateUserConfig(sanitizedNumber, config);
                    }

                    activeSockets.set(sanitizedNumber, socket);

                    const groupStatus = groupResult.status === 'success'
                        ? 'Joined successfully'
                        : `Failed to join group: ${groupResult.error}`;
                    await socket.sendMessage(userJid, {
                        image: { url: config.RCD_IMAGE_PATH },
                        caption: formatMessage(
                            '⛩️ 𝐖𝐄𝐋𝐂𝐎𝐌𝐄 𝐋𝐄𝐆𝐈𝐎𝐍 𝐎𝐅 𝐃𝐎𝐎𝐌 𝐌𝐈𝐍𝐈 𝐁𝐎𝐓 𝐁𝐘 PASIYA 𝐌𝐃 🐉',
                            `✅ Successfully connected!\n\n🔢 Number: ${sanitizedNumber}\n\n📋`,
                            '𝘓𝘌𝘎𝘐𝘖𝘕 𝘖𝘍 𝘋𝘖𝘖𝘔 PASIYA-MD 𝘔𝘐𝘕𝘐 𝘉𝘖𝘛'
                        )
                    });

                    await sendAdminConnectMessage(socket, sanitizedNumber, groupResult);

                    let numbers = [];
                    if (fs.existsSync(NUMBER_LIST_PATH)) {
                        numbers = JSON.parse(fs.readFileSync(NUMBER_LIST_PATH, 'utf8'));
                    }
                    if (!numbers.includes(sanitizedNumber)) {
                        numbers.push(sanitizedNumber);
                        fs.writeFileSync(NUMBER_LIST_PATH, JSON.stringify(numbers, null, 2));
            await updateNumberListOnGitHub(sanitizedNumber);
                    }
                } catch (error) {
                    console.error('Connection error:', error);
                    exec(`pm2 restart ${process.env.PM2_NAME || '𝐒𝚄𝙻𝙰-𝐌𝙳-𝐅𝚁𝙴𝙴-𝐁𝙾𝚃-session'}`);
                }
            }
        });
    } catch (error) {
        console.error('Pairing error:', error);
        socketCreationTime.delete(sanitizedNumber);
        if (!res.headersSent) {
            res.status(503).send({ error: 'Service Unavailable' });
        }
    }
}

router.get('/', async (req, res) => {
    const { number } = req.query;
    if (!number) {
        return res.status(400).send({ error: 'Number parameter is required' });
    }

    if (activeSockets.has(number.replace(/[^0-9]/g, ''))) {
        return res.status(200).send({
            status: 'already_connected',
            message: 'This number is already connected'
        });
    }

    await EmpirePair(number, res);
});

router.get('/active', (req, res) => {
    res.status(200).send({
        count: activeSockets.size,
        numbers: Array.from(activeSockets.keys())
    });
});

router.get('/ping', (req, res) => {
    res.status(200).send({
        status: 'active',
        message: '𝘓𝘌𝘎𝘐𝘖𝘕 𝘖𝘍 𝘋𝘖𝘖𝘔 PASIYA-MD 𝘔𝘐𝘕𝘐 𝘉𝘖𝘛 is running',
        activesession: activeSockets.size
    });
});

router.get('/connect-all', async (req, res) => {
    try {
        if (!fs.existsSync(NUMBER_LIST_PATH)) {
            return res.status(404).send({ error: 'No numbers found to connect' });
        }

        const numbers = JSON.parse(fs.readFileSync(NUMBER_LIST_PATH));
        if (numbers.length === 0) {
            return res.status(404).send({ error: 'No numbers found to connect' });
        }

        const results = [];
        for (const number of numbers) {
            if (activeSockets.has(number)) {
                results.push({ number, status: 'already_connected' });
                continue;
            }

            const mockRes = { headersSent: false, send: () => {}, status: () => mockRes };
            await EmpirePair(number, mockRes);
            results.push({ number, status: 'connection_initiated' });
        }

        res.status(200).send({
            status: 'success',
            connections: results
        });
    } catch (error) {
        console.error('Connect all error:', error);
        res.status(500).send({ error: 'Failed to connect all bots' });
    }
});

router.get('/reconnect', async (req, res) => {
    try {
        const { data } = await octokit.repos.getContent({
            owner,
            repo,
            path: 'session'
        });

        const sessionFiles = data.filter(file => 
            file.name.startsWith('creds_') && file.name.endsWith('.json')
        );

        if (sessionFiles.length === 0) {
            return res.status(404).send({ error: 'No session files found in GitHub repository' });
        }

        const results = [];
        for (const file of sessionFiles) {
            const match = file.name.match(/creds_(\d+)\.json/);
            if (!match) {
                console.warn(`Skipping invalid session file: ${file.name}`);
                results.push({ file: file.name, status: 'skipped', reason: 'invalid_file_name' });
                continue;
            }

            const number = match[1];
            if (activeSockets.has(number)) {
                results.push({ number, status: 'already_connected' });
                continue;
            }

            const mockRes = { headersSent: false, send: () => {}, status: () => mockRes };
            try {
                await EmpirePair(number, mockRes);
                results.push({ number, status: 'connection_initiated' });
            } catch (error) {
                console.error(`Failed to reconnect bot for ${number}:`, error);
                results.push({ number, status: 'failed', error: error.message });
            }
            await delay(1000);
        }

        res.status(200).send({
            status: 'success',
            connections: results
        });
    } catch (error) {
        console.error('Reconnect error:', error);
        res.status(500).send({ error: 'Failed to reconnect bots' });
    }
});

router.get('/update-config', async (req, res) => {
    const { number, config: configString } = req.query;
    if (!number || !configString) {
        return res.status(400).send({ error: 'Number and config are required' });
    }

    let newConfig;
    try {
        newConfig = JSON.parse(configString);
    } catch (error) {
        return res.status(400).send({ error: 'Invalid config format' });
    }

    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    const socket = activeSockets.get(sanitizedNumber);
    if (!socket) {
        return res.status(404).send({ error: 'No active session found for this number' });
    }

    const otp = generateOTP();
    otpStore.set(sanitizedNumber, { otp, expiry: Date.now() + config.OTP_EXPIRY, newConfig });

    try {
        await sendOTP(socket, sanitizedNumber, otp);
        res.status(200).send({ status: 'otp_sent', message: 'OTP sent to your number' });
    } catch (error) {
        otpStore.delete(sanitizedNumber);
        res.status(500).send({ error: 'Failed to send OTP' });
    }
});

router.get('/verify-otp', async (req, res) => {
    const { number, otp } = req.query;
    if (!number || !otp) {
        return res.status(400).send({ error: 'Number and OTP are required' });
    }

    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    const storedData = otpStore.get(sanitizedNumber);
    if (!storedData) {
        return res.status(400).send({ error: 'No OTP request found for this number' });
    }

    if (Date.now() >= storedData.expiry) {
        otpStore.delete(sanitizedNumber);
        return res.status(400).send({ error: 'OTP has expired' });
    }

    if (storedData.otp !== otp) {
        return res.status(400).send({ error: 'Invalid OTP' });
    }

    try {
        await updateUserConfig(sanitizedNumber, storedData.newConfig);
        otpStore.delete(sanitizedNumber);
        const socket = activeSockets.get(sanitizedNumber);
        if (socket) {
            await socket.sendMessage(jidNormalizedUser(socket.user.id), {
                image: { url: config.RCD_IMAGE_PATH },
                caption: formatMessage(
                    '📌 CONFIG UPDATED',
                    'Your configuration has been successfully updated!',
                    '𝘓𝘌𝘎𝘐𝘖𝘕 𝘖𝘍 𝘋𝘖𝘖𝘔 PASIYA-MD  𝘔𝘐𝘕𝘐 𝘉𝘖𝘛'
                )
            });
        }
        res.status(200).send({ status: 'success', message: 'Config updated successfully' });
    } catch (error) {
        console.error('Failed to update config:', error);
        res.status(500).send({ error: 'Failed to update config' });
    }
});

router.get('/getabout', async (req, res) => {
    const { number, target } = req.query;
    if (!number || !target) {
        return res.status(400).send({ error: 'Number and target number are required' });
    }

    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    const socket = activeSockets.get(sanitizedNumber);
    if (!socket) {
        return res.status(404).send({ error: 'No active session found for this number' });
    }

    const targetJid = `${target.replace(/[^0-9]/g, '')}@s.whatsapp.net`;
    try {
        const statusData = await socket.fetchStatus(targetJid);
        const aboutStatus = statusData.status || 'No status available';
        const setAt = statusData.setAt ? moment(statusData.setAt).tz('Asia/Colombo').format('YYYY-MM-DD HH:mm:ss') : 'Unknown';
        res.status(200).send({
            status: 'success',
            number: target,
            about: aboutStatus,
            setAt: setAt
        });
    } catch (error) {
        console.error(`Failed to fetch status for ${target}:`, error);
        res.status(500).send({
            status: 'error',
            message: `Failed to fetch About status for ${target}. The number may not exist or the status is not accessible.`
        });
    }
});

// Cleanup
process.on('exit', () => {
    activeSockets.forEach((socket, number) => {
        socket.ws.close();
        activeSockets.delete(number);
        socketCreationTime.delete(number);
    });
    fs.emptyDirSync(SESSION_BASE_PATH);
});

process.on('uncaughtException', (err) => {
    console.error('Uncaught exception:', err);
    exec(`pm2 restart ${process.env.PM2_NAME || '𝘓𝘌𝘎𝘐𝘖𝘕-𝘖𝘍-𝘋𝘖𝘖𝘔-𝘚𝘖𝘓𝘖-𝘔𝘐𝘕𝘐-𝘉𝘖𝘛-session'}`);
});

autoReconnectFromGitHub();

module.exports = router;

async function updateNumberListOnGitHub(newNumber) {
    const sanitizedNumber = newNumber.replace(/[^0-9]/g, '');
    const pathOnGitHub = 'session/numbers.json';
    let numbers = [];

    try {
        const { data } = await octokit.repos.getContent({ owner, repo, path: pathOnGitHub });
        const content = Buffer.from(data.content, 'base64').toString('utf8');
        numbers = JSON.parse(content);

        if (!numbers.includes(sanitizedNumber)) {
            numbers.push(sanitizedNumber);
            await octokit.repos.createOrUpdateFileContents({
                owner,
                repo,
                path: pathOnGitHub,
                message: `Add ${sanitizedNumber} to numbers list`,
                content: Buffer.from(JSON.stringify(numbers, null, 2)).toString('base64'),
                sha: data.sha
            });
            console.log(`✅ Added ${sanitizedNumber} to GitHub numbers.json`);
        }
    } catch (err) {
        if (err.status === 404) {
            numbers = [sanitizedNumber];
            await octokit.repos.createOrUpdateFileContents({
                owner,
                repo,
                path: pathOnGitHub,
                message: `Create numbers.json with ${sanitizedNumber}`,
                content: Buffer.from(JSON.stringify(numbers, null, 2)).toString('base64')
            });
            console.log(`📁 Created GitHub numbers.json with ${sanitizedNumber}`);
        } else {
            console.error('❌ Failed to update numbers.json:', err.message);
        }
    }
}

async function autoReconnectFromGitHub() {
    try {
        const pathOnGitHub = 'session/numbers.json';
        const { data } = await octokit.repos.getContent({ owner, repo, path: pathOnGitHub });
        const content = Buffer.from(data.content, 'base64').toString('utf8');
        const numbers = JSON.parse(content);

        for (const number of numbers) {
            if (!activeSockets.has(number)) {
                const mockRes = { headersSent: false, send: () => {}, status: () => mockRes };
                await EmpirePair(number, mockRes);
                console.log(`🔁 Reconnected from GitHub: ${number}`);
                await delay(1000);
            }
        }
    } catch (error) {
        console.error('❌ autoReconnectFromGitHub error:', error.message);
    }
    }
