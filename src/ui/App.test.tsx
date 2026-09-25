// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { App } from './App';
import { parseAddr } from '../engine/cells';

/*
 * 质检员复核流程的自动化验收：
 * 以含下游公式（B1/C1/B2 依赖 A1/A2）与错误传播（F 列循环、H 列除零）的网格，
 * 依次覆盖两种空编辑（公式栏聚焦后原样点到别处、双击网格进入编辑后原样离开）、
 * Enter 确认与 Esc 取消，逐步比较修订号、原始输入、精确结果、
 * 预演可采纳状态与导出 JSON，并确认取消操作不使有效预演失效。
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

interface ExportedCellJson {
  addr: string;
  raw: string;
  value: { n: string; d: string } | null;
  display: string | null;
  error: {
    type: string;
    message: string;
    source: string;
    path: string[];
    cycle?: string[];
  } | null;
}

interface ExportedJson {
  format: string;
  version: number;
  revision: number;
  cells: ExportedCellJson[];
}

let exportedBlobs: Blob[] = [];

beforeEach(() => {
  exportedBlobs = [];
  URL.createObjectURL = ((blob: Blob) => {
    exportedBlobs.push(blob);
    return 'blob:mock';
  }) as typeof URL.createObjectURL;
  URL.revokeObjectURL = (() => undefined) as typeof URL.revokeObjectURL;
  // 阻止 jsdom 对 <a> 导航的“未实现”噪音；导出内容已从 Blob 截获
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** 载入演示网格（含下游公式与错误传播），返回常用查询工具 */
function setup() {
  const utils = render(<App />);
  fireEvent.click(screen.getByText('载入演示'));
  return utils.container;
}

function formulaBar(): HTMLInputElement {
  return screen.getByPlaceholderText(/输入整数/) as HTMLInputElement;
}

/** 工具栏显示的当前修订号 */
function revision(): number {
  const m = /快照修订 r(\d+)/.exec(
    screen.getByText(/快照修订/).textContent ?? '',
  );
  return Number(m![1]);
}

function cellTd(container: HTMLElement, addr: string): HTMLElement {
  const p = parseAddr(addr)!;
  const row = container.querySelectorAll('table.sheet tbody tr')[p.row];
  return row.querySelectorAll('td')[p.col + 1] as HTMLElement; // 首列是行头
}

/** 非编辑态的格内容 div（可点击/双击） */
function cellEl(container: HTMLElement, addr: string): HTMLElement {
  const div = cellTd(container, addr).querySelector('.cell');
  if (!div) throw new Error(`${addr} 正处于编辑态`);
  return div as HTMLElement;
}

function cellText(container: HTMLElement, addr: string): string {
  return cellTd(container, addr).textContent ?? '';
}

function editingInput(container: HTMLElement): HTMLInputElement {
  const el = container.querySelector('input.cell-input');
  if (!el) throw new Error('没有处于编辑态的网格单元格');
  return el as HTMLInputElement;
}

/** 点击“导出 JSON 快照”并解析（忽略 exportedAt 时间戳） */
async function exportJson(): Promise<ExportedJson> {
  fireEvent.click(screen.getByText('导出 JSON 快照'));
  const blob = exportedBlobs[exportedBlobs.length - 1];
  const obj = JSON.parse(await blob.text()) as ExportedJson & {
    exportedAt: string;
  };
  delete (obj as Partial<typeof obj>).exportedAt;
  return obj;
}

function cellOf(j: ExportedJson, addr: string): ExportedCellJson {
  return j.cells.find((c) => c.addr === addr)!;
}

/** 在假设修改工作区填写一组候选并预演 */
function runPreview(container: HTMLElement, addr: string, raw: string) {
  const addrInput = container.querySelector(
    'input.hyp-addr-input',
  ) as HTMLInputElement;
  const rawInput = container.querySelector(
    'input.hyp-raw-input',
  ) as HTMLInputElement;
  fireEvent.change(addrInput, { target: { value: addr } });
  fireEvent.change(rawInput, { target: { value: raw } });
  fireEvent.click(screen.getByText('预演整组修改'));
}

describe('验收：空编辑不产生新修订', () => {
  it('公式栏聚焦已有单元格、未改一个字符就点到别处：一切不变', async () => {
    const container = setup();
    expect(revision()).toBe(1);
    const j0 = await exportJson();

    // 选中 A1，聚焦公式栏（草稿载入原值），未改动直接点到别处
    fireEvent.click(cellEl(container, 'A1'));
    const bar = formulaBar();
    expect(bar.value).toBe('8');
    act(() => {
      bar.focus();
    });
    expect(bar.value).toBe('8');
    act(() => {
      bar.blur();
    });

    // 修订号、原始输入、精确结果、错误传播全部不变
    expect(revision()).toBe(1);
    expect(bar.value).toBe('8');
    expect(cellText(container, 'B1')).toBe('14');
    expect(cellText(container, 'C1')).toBe('11.(3)');
    expect(cellText(container, 'F1')).toBe('#CYCLE!');
    expect(cellText(container, 'H2')).toBe('#DIV/0!');
    expect(cellText(container, 'H3')).toBe('#DIV/0!');

    // 导出 JSON 与空编辑前逐字节一致
    expect(await exportJson()).toEqual(j0);
  });

  it('双击网格单元格进入编辑后原样离开（Enter 与点到别处）：一切不变', async () => {
    const container = setup();
    expect(revision()).toBe(1);
    const j0 = await exportJson();

    // 双击 B1，未改动直接 Enter 离开
    fireEvent.dblClick(cellEl(container, 'B1'));
    const input1 = editingInput(container);
    expect(input1.value).toBe('=A1+A2*2');
    fireEvent.keyDown(input1, { key: 'Enter' });
    expect(revision()).toBe(1);

    // 双击 C1，未改动直接点到别处（blur）离开
    fireEvent.dblClick(cellEl(container, 'C1'));
    const input2 = editingInput(container);
    expect(input2.value).toBe('=B1-B2');
    act(() => {
      input2.blur();
    });
    expect(revision()).toBe(1);

    // 原始输入与精确结果不变，导出一致
    expect(cellText(container, 'B1')).toBe('14');
    expect(cellText(container, 'C1')).toBe('11.(3)');
    expect(await exportJson()).toEqual(j0);
  });

  it('空编辑不使有效预演过期：预演后空编辑，采纳仍然可用', async () => {
    const container = setup();
    expect(revision()).toBe(1);

    // 基于 r1 预演：A1 → 5
    fireEvent.click(screen.getByText('假设修改'));
    runPreview(container, 'A1', '5');
    expect(screen.queryByText(/预演已过期/)).toBeNull();

    // 期间发生两种空编辑
    fireEvent.click(cellEl(container, 'A1'));
    const bar = formulaBar();
    act(() => {
      bar.focus();
    });
    act(() => {
      bar.blur();
    });
    fireEvent.dblClick(cellEl(container, 'B1'));
    fireEvent.keyDown(editingInput(container), { key: 'Enter' });

    // 预演未过期，采纳成功且只前进一个修订号
    expect(revision()).toBe(1);
    expect(screen.queryByText(/预演已过期/)).toBeNull();
    const adopt = screen.getByText('一次性采纳全部') as HTMLButtonElement;
    expect(adopt.disabled).toBe(false);
    fireEvent.click(adopt);
    expect(revision()).toBe(2);
    expect(cellText(container, 'A1')).toBe('5');
    expect(cellText(container, 'B1')).toBe('11'); // 5 + 3*2
  });
});

describe('验收：Enter 确认只形成一次提交', () => {
  it('公式栏输入新公式按一次 Enter：格值更新一次、修订号只 +1、旧预演过期', async () => {
    const container = setup();
    expect(revision()).toBe(1);

    // 先建立基于 r1 的预演（A1 → 5），用于随后验证过期判定
    fireEvent.click(screen.getByText('假设修改'));
    runPreview(container, 'A1', '5');
    expect(screen.queryByText(/预演已过期/)).toBeNull();

    // 公式栏把 A1 改成 10，按一次 Enter
    fireEvent.click(cellEl(container, 'A1'));
    const bar = formulaBar();
    act(() => {
      bar.focus();
    });
    fireEvent.change(bar, { target: { value: '10' } });
    fireEvent.keyDown(bar, { key: 'Enter' });

    // 一次确认 = 一次提交：r1 → r2，恰好 +1
    expect(revision()).toBe(2);
    expect(bar.value).toBe('10');

    // 下游精确重算：B1=16，B2=10/3，C1=38/3
    expect(cellText(container, 'B1')).toBe('16');
    expect(cellText(container, 'B2')).toBe('3.(3)');
    expect(cellText(container, 'C1')).toBe('12.(6)');
    // 错误传播不受无关编辑影响
    expect(cellText(container, 'F1')).toBe('#CYCLE!');
    expect(cellText(container, 'H2')).toBe('#DIV/0!');

    // 导出与这一次提交对应：版本数、原始输入、精确分数
    const j = await exportJson();
    expect(j.revision).toBe(2);
    expect(cellOf(j, 'A1').raw).toBe('10');
    expect(cellOf(j, 'B1').value).toEqual({ n: '16', d: '1' });
    expect(cellOf(j, 'B2').value).toEqual({ n: '10', d: '3' });
    expect(cellOf(j, 'C1').value).toEqual({ n: '38', d: '3' });
    expect(cellOf(j, 'H2').error!.type).toBe('divzero');
    expect(cellOf(j, 'H3').error).toMatchObject({
      type: 'divzero',
      source: 'H2',
      path: ['H2', 'H3'],
    });
    expect(cellOf(j, 'F1').error!.type).toBe('cycle');

    // 真实编辑使基于 r1 的预演过期：提示出现、采纳禁用
    expect(screen.getByText(/预演已过期/)).toBeTruthy();
    expect(
      (screen.getByText('一次性采纳全部') as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});

describe('验收：Esc 取消必须保留原格及下游快照', () => {
  it('公式栏输入未确认值后按 Esc：不写入、不重算、不使有效预演失效', async () => {
    const container = setup();
    expect(revision()).toBe(1);
    const j0 = await exportJson();

    // 基于 r1 的有效预演：A2 → 7
    fireEvent.click(screen.getByText('假设修改'));
    runPreview(container, 'A2', '7');
    expect(screen.queryByText(/预演已过期/)).toBeNull();

    // 公式栏输入尚未确认的 99，按 Esc 取消
    fireEvent.click(cellEl(container, 'A2'));
    const bar = formulaBar();
    expect(bar.value).toBe('3');
    act(() => {
      bar.focus();
    });
    fireEvent.change(bar, { target: { value: '99' } });
    fireEvent.keyDown(bar, { key: 'Escape' });

    // 取消不写入：修订号、原始输入、公式栏显示全部还原
    expect(revision()).toBe(1);
    expect(bar.value).toBe('3');
    expect(cellText(container, 'A2')).toBe('3');
    // 下游与错误来源未被重算污染
    expect(cellText(container, 'B1')).toBe('14');
    expect(cellText(container, 'C1')).toBe('11.(3)');
    expect(cellText(container, 'H2')).toBe('#DIV/0!');

    // 导出不包含本应取消的内容，与取消前逐字节一致
    const j1 = await exportJson();
    expect(j1).toEqual(j0);
    expect(cellOf(j1, 'A2').raw).toBe('3');

    // 取消不使有效预演失效：采纳成功，修订号只 +1
    expect(screen.queryByText(/预演已过期/)).toBeNull();
    fireEvent.click(screen.getByText('一次性采纳全部'));
    expect(revision()).toBe(2);
    expect(cellText(container, 'A2')).toBe('7');
    expect(cellText(container, 'B1')).toBe('22'); // 8 + 7*2
    const j2 = await exportJson();
    expect(j2.revision).toBe(2);
    expect(cellOf(j2, 'A2').raw).toBe('7');
    expect(cellOf(j2, 'B1').value).toEqual({ n: '22', d: '1' });
  });

  it('网格编辑中输入未确认值后按 Esc：不写入正式格', async () => {
    const container = setup();
    expect(revision()).toBe(1);
    const j0 = await exportJson();

    fireEvent.dblClick(cellEl(container, 'A2'));
    const input = editingInput(container);
    fireEvent.change(input, { target: { value: '77' } });
    fireEvent.keyDown(input, { key: 'Escape' });

    expect(revision()).toBe(1);
    expect(cellText(container, 'A2')).toBe('3');
    expect(cellText(container, 'B1')).toBe('14');
    expect(await exportJson()).toEqual(j0);
  });
});
