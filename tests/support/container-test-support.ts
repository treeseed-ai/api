import {test,expect} from 'bun:test';
import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {ApiContainerBuild,NodeApiContainerPlugin} from '../../src/container.js';
import {InstalledSchemas} from '@treeseed-cordis/sdk';
