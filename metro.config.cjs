const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(process.cwd());

config.watchFolders = [process.cwd()];

config.resolver.blockList = [
  /attached_assets\/.*/,
  /\.local\/.*/,
  /patches\/.*/,
  /[/\\]scripts[/\\]build\.js$/,
];

module.exports = config;
