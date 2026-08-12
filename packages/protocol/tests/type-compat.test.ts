/**
 * 跨包契约：core 事件类型 ⊆ wire 类型 且 wire ⊆ core（编译期完成，tsc 即测试）。
 * core 契约增量时此文件强制 protocol 同步。
 * 注意：本测试 tsconfig 关闭 exactOptionalPropertyTypes（zod .optional() 推导
 * `?: T | undefined`，与 core 的 `?: T` 仅在该严格项下不互赋）。
 */

import { expect, it } from 'bun:test';
import type {
  ChatCompactionResult,
  ChatEvent,
  ChatMemorySnapshot,
  ChatModelListing,
  ChatSessionSummary,
} from '@tachikoma/core';

import type { ChatEventWire } from '../src/events';
import type { CompactionResult, MemorySnapshot, ModelListing, SessionSummary } from '../src/dto';

type AssertMutual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;

// 编译期断言：任一方向不可赋值时这里直接编译失败。
const eventCompat: AssertMutual<ChatEvent, ChatEventWire> = true;
const summaryCompat: AssertMutual<ChatSessionSummary, SessionSummary> = true;
const compactionCompat: AssertMutual<ChatCompactionResult, CompactionResult> = true;
const memoryCompat: AssertMutual<ChatMemorySnapshot, MemorySnapshot> = true;
const listingCompat: AssertMutual<ChatModelListing, ModelListing> = true;

it('core 与 wire 类型双向兼容（编译期已验证）', () => {
  expect(
    eventCompat && summaryCompat && compactionCompat && memoryCompat && listingCompat
  ).toBeTrue();
});
