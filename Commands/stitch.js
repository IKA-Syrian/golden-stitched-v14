const { SlashCommandBuilder } = require('@discordjs/builders')

const Stitch = new SlashCommandBuilder()
    .setName('stitch')
    .setDescription('Stitch chapters from drive links')
    .addStringOption(option => option.setName('link').setDescription('The link').setRequired(true))
    .addIntegerOption(option => option.setName('height').setDescription('The height of the image').setRequired(true))
    .addStringOption(option => option.setName('format').setDescription('The format of the image').setRequired(true))
    .addStringOption(option => option.setName('width').setDescription('The width of the image').setRequired(false))

module.exports = Stitch.toJSON()