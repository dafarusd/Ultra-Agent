const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const config = getDefaultConfig(__dirname);

config.watcher = {
  ...config.watcher,
  additionalExts: config.watcher?.additionalExts || [],
};

config.resolver = {
  ...config.resolver,
  blockList: [
    /\.local\/.*/,
    /\.git\/.*/,
  ],
};

module.exports = config;
