module.exports = {
  name: 'menu',
  description: 'Main menu',
  execute(sock, msg, args) {
    const menuText = `🧠 *Bot Menu* 🧠\n\n1. .ping\n2. .status\n3. .help`;
    sock.sendMessage(msg.key.remoteJid, { text: menuText });
  }
};
