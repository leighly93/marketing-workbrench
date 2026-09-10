'use strict';

const path = require('node:path');
const { workspaceRoot } = require('../../paths');
require('dotenv').config({ path: path.join(workspaceRoot(path.resolve(__dirname, '..')), '.env'), quiet: true });
module.exports = require('./index');
