module.exports.formatMessage = (title, content, footer) => {
    return `*${title}*\n\n${content}\n\n> *${footer}*`;
};
