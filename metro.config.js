const { getDefaultConfig } = require("expo/metro-config");
const path = require("path");

const config = getDefaultConfig(__dirname);

config.watchFolders = [__dirname];

config.resolver.blockList = [
  /attached_assets\/.*/,
  /\.local\/.*/,
  new RegExp('^' + path.join(__dirname, 'scripts').replace(/\\/g, '\\\\') + '.*'),
  /patches\/.*/,
];

module.exports = config;
