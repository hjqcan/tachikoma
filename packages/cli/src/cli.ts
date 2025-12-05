#!/usr/bin/env bun

/**
 * Tachikoma CLI 入口
 */

import { VERSION } from './index';

/**
 * 显示帮助信息
 */
function showHelp() {
  console.log(`
Tachikoma CLI v${VERSION}

使用方式:
  tachikoma <command> [options]

命令:
  init        初始化新项目
  run         运行智能体任务
  status      查看任务状态
  help        显示帮助信息

选项:
  -v, --version   显示版本号
  -h, --help      显示帮助信息

示例:
  tachikoma init my-project
  tachikoma run "实现用户认证功能"
`);
}

/**
 * 显示版本
 */
function showVersion() {
  console.log(`Tachikoma CLI v${VERSION}`);
}

/**
 * 主入口
 */
function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === 'help' || command === '-h' || command === '--help') {
    showHelp();
    return;
  }

  if (command === '-v' || command === '--version') {
    showVersion();
    return;
  }

  // TODO: 实现具体命令
  console.log(`命令 "${command}" 尚未实现`);
}

main();
