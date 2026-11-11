import { defineConfig } from '@playwright/test';
import { existsSync } from 'node:fs';
const browser=process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE||['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe','C:/Program Files/Google/Chrome/Application/chrome.exe'].find(existsSync);
export default defineConfig({testDir:'./tests',testMatch:'**/*.spec.mjs',workers:1,timeout:60000,use:{headless:true,launchOptions:browser?{executablePath:browser}:{}},reporter:'list'});
