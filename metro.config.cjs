const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);

config.watchFolders = [__dirname];

config.resolver.blockList = [
  /attached_assets\/.*/,
  /\.local\/.*/,
  /patches\/.*/,
  /[/\\]scripts[/\\]build\.js$/,
];

module.exports = config;
