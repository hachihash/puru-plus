export type Difficulty = "easy" | "normal" | "hard" | "god";

export type Move = { from: number; to: number };

const BOARD_SIZE = 2;
const TILE_COUNT = BOARD_SIZE * BOARD_SIZE;
const TURN_ACTIONS = 3;

const LEGAL_MOVES: Move[] = (() => {
  const moves: Move[] = [];
  const isAdjacent = (a: number, b: number) => {
    const ar = Math.floor(a / BOARD_SIZE);
    const ac = a % BOARD_SIZE;
    const br = Math.floor(b / BOARD_SIZE);
    const bc = b % BOARD_SIZE;
    return (ar === br && Math.abs(ac - bc) === 1) || (ac === bc && Math.abs(ar - br) === 1);
  };

  for (let from = 0; from < TILE_COUNT; from++) {
    for (let to = 0; to < TILE_COUNT; to++) {
      if (from === to) continue;
      if (!isAdjacent(from, to)) continue;
      moves.push({ from, to });
    }
  }
  return moves; // 2x2 => always 8 moves
})();

function computeToValue(sum: number, target: number) {
  return sum === target ? target : sum > target ? sum % target : sum;
}

function applyMove(board: number[], from: number, to: number, refillValue: number, target: number): {
  nextBoard: number[];
  didWin: boolean;
} {
  const sum = board[to]! + board[from]!;
  const next: number[] = [...board];
  next[to] = computeToValue(sum, target);
  next[from] = refillValue;
  return { nextBoard: next, didWin: sum === target };
}

function powInt(base: number, exp: number) {
  let r = 1;
  for (let i = 0; i < exp; i++) r *= base;
  return r;
}

function findWinAtStep(
  board: number[],
  nextQueue: number[],
  nextIndex: number,
  target: number,
  stepNumber: 1 | 2 | 3,
): Move[] | null {
  // stepNumber = 1 means: win on the first action.
  // stepNumber = 2 means: no win on first action, win on second action.
  // stepNumber = 3 means: no win on first two actions, win on third action.
  if (stepNumber === 1) {
    const refill0 = nextQueue[nextIndex] ?? 1;
    for (const m of LEGAL_MOVES) {
      const { didWin } = applyMove(board, m.from, m.to, refill0, target);
      if (didWin) return [m];
    }
    return null;
  }

  if (stepNumber === 2) {
    const refill0 = nextQueue[nextIndex] ?? 1;
    const refill1 = nextQueue[nextIndex + 1] ?? 1;
    for (const m0 of LEGAL_MOVES) {
      const r0 = applyMove(board, m0.from, m0.to, refill0, target);
      if (r0.didWin) continue; // would be a 1-step win
      for (const m1 of LEGAL_MOVES) {
        const r1 = applyMove(r0.nextBoard, m1.from, m1.to, refill1, target);
        if (r1.didWin) return [m0, m1];
      }
    }
    return null;
  }

  // stepNumber === 3
  const refill0 = nextQueue[nextIndex] ?? 1;
  const refill1 = nextQueue[nextIndex + 1] ?? 1;
  const refill2 = nextQueue[nextIndex + 2] ?? 1;
  for (const m0 of LEGAL_MOVES) {
    const r0 = applyMove(board, m0.from, m0.to, refill0, target);
    if (r0.didWin) continue;
    for (const m1 of LEGAL_MOVES) {
      const r1 = applyMove(r0.nextBoard, m1.from, m1.to, refill1, target);
      if (r1.didWin) continue;
      for (const m2 of LEGAL_MOVES) {
        const r2 = applyMove(r1.nextBoard, m2.from, m2.to, refill2, target);
        if (r2.didWin) return [m0, m1, m2];
      }
    }
  }
  return null;
}

function countOpponentWinningPatterns(
  board: number[],
  nextQueue: number[],
  nextIndex: number,
  target: number,
  depth: number,
  cache: Map<string, number>,
): number {
  // Count how many move sequences (length=depth) result in at least one win for opponent.
  // If a win occurs at step k, all continuations are counted as winning sequences.
  if (depth <= 0) return 0;
  const key = `${board.join(",")}|${nextIndex}|${target}|${depth}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;

  const base = LEGAL_MOVES.length;
  const winPow = (remainingAfterWin: number) => powInt(base, remainingAfterWin);

  const dfs = (b: number[], actionIndex: number, d: number): number => {
    if (d === 0) return 0;
    const refill = nextQueue[actionIndex] ?? 1;
    let count = 0;
    if (d === 1) {
      for (const m of LEGAL_MOVES) {
        const { didWin } = applyMove(b, m.from, m.to, refill, target);
        if (didWin) count += 1;
      }
      return count;
    }

    for (const m of LEGAL_MOVES) {
      const { nextBoard, didWin } = applyMove(b, m.from, m.to, refill, target);
      if (didWin) {
        // Win at this step => all remaining continuations count as winning.
        count += winPow(d - 1);
      } else {
        count += dfs(nextBoard, actionIndex + 1, d - 1);
      }
    }
    return count;
  };

  const result = dfs(board, nextIndex, depth);
  cache.set(key, result);
  return result;
}

function enumerateAiLinesNonWinning(
  board: number[],
  nextQueue: number[],
  nextIndex: number,
  target: number,
  depth: number,
): { line: Move[]; finalBoard: number[] }[] {
  // Enumerate all AI lines of exact length=depth.
  // Include only lines that do NOT create a win within those actions.
  const out: { line: Move[]; finalBoard: number[] }[] = [];

  const dfs = (b: number[], actionIndex: number, d: number, prefix: Move[]) => {
    if (d === 0) {
      out.push({ line: prefix, finalBoard: b });
      return;
    }
    const refill = nextQueue[actionIndex] ?? 1;
    for (const m of LEGAL_MOVES) {
      const r = applyMove(b, m.from, m.to, refill, target);
      if (r.didWin) continue; // disallow win inside the line
      dfs(r.nextBoard, actionIndex + 1, d - 1, [...prefix, m]);
    }
  };

  dfs(board, nextIndex, depth, []);
  return out;
}

function enumerateAiLinesAllowWinning(
  board: number[],
  nextQueue: number[],
  nextIndex: number,
  target: number,
  depth: number,
): { line: Move[]; finalBoard: number[] }[] {
  const out: { line: Move[]; finalBoard: number[] }[] = [];
  const dfs = (b: number[], actionIndex: number, d: number, prefix: Move[]) => {
    if (d === 0) {
      out.push({ line: prefix, finalBoard: b });
      return;
    }
    const refill = nextQueue[actionIndex] ?? 1;
    for (const m of LEGAL_MOVES) {
      const r = applyMove(b, m.from, m.to, refill, target);
      // If AI wins early, in the real game it would stop, but for evaluation we still keep it
      // (fallback usage only).
      dfs(r.nextBoard, actionIndex + 1, d - 1, [...prefix, m]);
    }
  };
  dfs(board, nextIndex, depth, []);
  return out;
}

function chooseDefensiveLine(
  board: number[],
  nextQueue: number[],
  nextIndex: number,
  target: number,
  remaining: number,
  opponentDepth: number,
  rng: () => number,
): Move[] | null {
  const aiLines = enumerateAiLinesNonWinning(board, nextQueue, nextIndex, target, remaining);
  const linesToEval = aiLines.length ? aiLines : enumerateAiLinesAllowWinning(board, nextQueue, nextIndex, target, remaining);

  const cache = new Map<string, number>();
  const opponentNextIndex = nextIndex + remaining;

  let best: { line: Move[]; finalBoard: number[]; count: number } | null = null;
  for (const ln of linesToEval) {
    const count = countOpponentWinningPatterns(ln.finalBoard, nextQueue, opponentNextIndex, target, opponentDepth, cache);

    if (!best) {
      best = { line: ln.line, finalBoard: ln.finalBoard, count };
      continue;
    }

    if (best.count === 0 && count === 0) {
      // tie: choose randomly
      if (rng() < 0.5) best = { line: ln.line, finalBoard: ln.finalBoard, count };
      continue;
    }
    if (best.count === 0 && count !== 0) continue; // keep safe one
    if (count === 0 && best.count !== 0) {
      best = { line: ln.line, finalBoard: ln.finalBoard, count };
      continue;
    }
    if (count < best.count) {
      best = { line: ln.line, finalBoard: ln.finalBoard, count };
      continue;
    }
    if (count === best.count && rng() < 0.5) {
      best = { line: ln.line, finalBoard: ln.finalBoard, count };
      continue;
    }
  }

  return best?.line ?? null;
}

function countOpponentWinStepPatterns3(
  board: number[],
  nextQueue: number[],
  nextIndex: number,
  target: number,
): { c1: number; c2: number; c3: number; total: number } {
  // Depth=3 fixed => 8^3=512 sequences.
  // c1/c2/c3 count how many sequences result in a win at step 1/2/3.
  const base = LEGAL_MOVES.length; // 8
  const mul = (step: 1 | 2 | 3) => powInt(base, 3 - step);

  let c1 = 0;
  let c2 = 0;
  let c3 = 0;

  const refill0 = nextQueue[nextIndex] ?? 1;
  const refill1 = nextQueue[nextIndex + 1] ?? 1;
  const refill2 = nextQueue[nextIndex + 2] ?? 1;

  for (const m0 of LEGAL_MOVES) {
    const r0 = applyMove(board, m0.from, m0.to, refill0, target);
    if (r0.didWin) {
      c1 += mul(1);
      continue;
    }

    for (const m1 of LEGAL_MOVES) {
      const r1 = applyMove(r0.nextBoard, m1.from, m1.to, refill1, target);
      if (r1.didWin) {
        c2 += mul(2);
        continue;
      }

      for (const m2 of LEGAL_MOVES) {
        const r2 = applyMove(r1.nextBoard, m2.from, m2.to, refill2, target);
        if (r2.didWin) {
          c3 += mul(3);
        }
      }
    }
  }

  const total = c1 + c2 + c3;
  return { c1, c2, c3, total };
}

function chooseGodDefensiveLine(
  board: number[],
  nextQueue: number[],
  nextIndex: number,
  target: number,
  remaining: number,
  rng: () => number,
): Move[] | null {
  const aiLines = enumerateAiLinesNonWinning(board, nextQueue, nextIndex, target, remaining);
  if (!aiLines.length) return null;

  const opponentNextIndex = nextIndex + remaining;

  let best:
    | {
        line: Move[];
        c1: number;
        c2: number;
        c3: number;
        total: number;
      }
    | null = null;

  for (const ln of aiLines) {
    const counts = countOpponentWinStepPatterns3(ln.finalBoard, nextQueue, opponentNextIndex, target);

    if (!best) {
      best = { line: ln.line, ...counts };
      continue;
    }

    // A: minimize total winning sequences
    if (counts.total !== best.total) {
      if (counts.total < best.total) best = { line: ln.line, ...counts };
      continue;
    }

    // B: among ties, avoid 1-step wins first, then 2-step wins
    if (counts.c1 !== best.c1) {
      if (counts.c1 < best.c1) best = { line: ln.line, ...counts };
      continue;
    }
    if (counts.c2 !== best.c2) {
      if (counts.c2 < best.c2) best = { line: ln.line, ...counts };
      continue;
    }

    // Perfect tie: slight randomness
    if (rng() < 0.5) best = { line: ln.line, ...counts };
  }

  return best?.line ?? null;
}

export function getCpuMovePlan(input: {
  board: number[];
  target: number;
  nextQueue: number[];
  nextIndex: number;
  movesLeft: number;
  difficulty: Difficulty;
  rng?: () => number;
}): { line: Move[] } | null {
  const rng = input.rng ?? Math.random;
  const remaining = Math.min(TURN_ACTIONS, Math.max(1, input.movesLeft));
  if (input.board.length !== TILE_COUNT) return null;

  const board = input.board;
  const nextQueue = input.nextQueue;
  const idx = input.nextIndex;
  const target = input.target;
  const d = input.difficulty;

  const win1 = remaining >= 1 ? findWinAtStep(board, nextQueue, idx, target, 1) : null;
  const win2 = remaining >= 2 ? findWinAtStep(board, nextQueue, idx, target, 2) : null;
  const win3 = remaining >= 3 ? findWinAtStep(board, nextQueue, idx, target, 3) : null;

  // 1) Attack priority (all difficulties):
  // Choose the shortest finishing path (1-step > 2-step > 3-step).
  if (win1) return { line: win1 };
  if (win2) return { line: win2 };
  if (win3) return { line: win3 };

  // Defense depends on difficulty.
  if (d === "easy") {
    const line = chooseDefensiveLine(board, nextQueue, idx, target, remaining, 1, rng);
    return line ? { line } : null;
  }
  if (d === "normal") {
    const line = chooseDefensiveLine(board, nextQueue, idx, target, remaining, 2, rng);
    return line ? { line } : null;
  }
  if (d === "hard") {
    // Prevent opponent from completing a 1-step or 2-step win in their next turn.
    const line = chooseDefensiveLine(board, nextQueue, idx, target, remaining, 2, rng);
    return line ? { line } : null;
  }

  // God:最悪ケース回避（512通りを手数別に評価）
  if (d === "god") {
    const line = chooseGodDefensiveLine(board, nextQueue, idx, target, remaining, rng);
    return line ? { line } : null;
  }

  return null;
}

