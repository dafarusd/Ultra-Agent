const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const config = getDefaultConfig(__dirname);

config.watchFolders = [__dirname];

config.resolver.blockList = [
  /\.local[\/\\]state[\/\\].*/,
  /\.local[\/\\]skills[\/\\]\.old-.*/,
  /\.local[\/\\]tmp[\/\\].*/,
];

module.exports = config;
