"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { createClient, type RealtimeChannel } from "@supabase/supabase-js";
import confettiBurst from "canvas-confetti";
import { getCpuMovePlan } from "../engine/ai";

type Player = 1 | 2;
type Winner = Player | null;
type GameMode = "cpu" | "local" | "online";
type CpuDifficulty = "easy" | "normal" | "hard" | "god";
type TargetValue = number;
type FirstTurn = "p1" | "p2" | "random";
type Screen = "title" | "menu" | "settings" | "onlineWaiting" | "matching" | "play" | "stats";
type TimeLimitChoice = "3" | "15" | "30" | "none";

type OnlineRole = "host" | "guest";
type OnlineState = {
  enabled: boolean;
  roomId: string;
  role: OnlineRole;
  player: Player;
  clientId: string;
  ready: boolean;
};

type PublicMatchRow = {
  id: number;
  room_id: string;
  status: "waiting" | "playing";
};

// Supabase: プレイヤーごとの Elo レートを保持するテーブルの形を想定
// （実際の DB スキーマに合わせて調整してください）
type PlayerRatingRow = {
  user_id: string;
  rating: number;
  updated_at?: string;
};

// Supabase: 1試合ごとの履歴（勝敗/ターン数/種類など）を保存するテーブルを想定
type MatchHistoryInsert = {
  player1_id: string;
  player2_id: string;
  winner_id: string;
  turns: number;
  // match_type は Stats で集計するため、CPUも含めて種類を区別する
  match_type: "random" | "room" | "cpu_easy" | "cpu_normal" | "cpu_hard" | "cpu_god";
  // 25 が初めて盤面に出るまでのターン数（未達なら null）
  turns_to_goal25?: number | null;
  created_at: string;
};

type MatchHistoryRow = {
  id?: number;
  player1_id: string;
  player2_id: string;
  winner_id: string;
  turns: number;
  match_type: string;
  turns_to_goal25?: number | null;
  created_at: string;
};

type OnlineBroadcastState = {
  clientId: string;
  target: number;
  board: number[];
  nextNumber: number;
  nextQueue: number[];
  nextIndex: number;
  currentPlayer: Player;
  movesLeft: number;
  turns: number;
  winner: Winner;
  startingPlayer: Player;
  actionDeadlineMs?: number | null;
  // 勝利確定時の理由（25ゴール演出のディレイ有無などに使う）
  winReason?: "goal" | "surrender";
};

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY");
}
const supabase = createClient(supabaseUrl, supabaseAnonKey);

const BOARD_SIZE = 2;
const TILE_COUNT = BOARD_SIZE * BOARD_SIZE;
const DEFAULT_TARGET: TargetValue = 25;
const TURN_ACTIONS = 3;
const SE_GAINS: Record<string, number> = {
  // make.mp3がwin.mp3より小さく聞こえるため、ゲインを少し上げる
  make: 1.35,
};

function randInt(min: number, max: number) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * Elo レーティング更新用の計算関数（ランダム対戦のみ使用）
 *
 * - expectedA: A が勝つ確率（B のレートから算出）
 * - scoreA: 実結果（勝ち=1, 負け=0。引き分けはこのゲームでは想定しない）
 * - newRating = rating + K * (score - expected)
 */
function calcEloAfterMatch(params: {
  ratingA: number;
  ratingB: number;
  winner: "A" | "B";
  kFactor?: number; // 32 前後を想定
}): { newRatingA: number; newRatingB: number } {
  const { ratingA, ratingB, winner } = params;
  const K = params.kFactor ?? 32;

  const expectedA = 1 / (1 + Math.pow(10, (ratingB - ratingA) / 400));
  const expectedB = 1 - expectedA;

  const scoreA = winner === "A" ? 1 : 0;
  const scoreB = winner === "B" ? 1 : 0;

  const newRatingA = Math.round(ratingA + K * (scoreA - expectedA));
  const newRatingB = Math.round(ratingB + K * (scoreB - expectedB));

  return { newRatingA, newRatingB };
}

function safeStringify(value: unknown) {
  // Error オブジェクトは JSON stringify しないと {} になりやすいため、
  // 可能な範囲で中身を文字列化する（デバッグ用途）。
  try {
    return JSON.stringify(value, (_k, v) => {
      if (typeof v === "bigint") return v.toString();
      return v;
    }, 2);
  } catch {
    return String(value);
  }
}

type SupabaseErrorLike = {
  message?: string;
  details?: string;
  hint?: string;
  status?: number;
  code?: string;
};

function makeInitialBoard(): number[] {
  return Array.from({ length: TILE_COUNT }, () => randInt(1, 9));
}

function isAdjacent(a: number, b: number) {
  const ar = Math.floor(a / BOARD_SIZE);
  const ac = a % BOARD_SIZE;
  const br = Math.floor(b / BOARD_SIZE);
  const bc = b % BOARD_SIZE;
  return (ar === br && Math.abs(ac - bc) === 1) || (ac === bc && Math.abs(ar - br) === 1);
}

function computeToValue(sum: number, target: number) {
  return sum === target ? target : sum > target ? sum % target : sum;
}

function listAllMovesForTarget(b: number[]): Array<{ from: number; to: number; sum: number }> {
  const moves: Array<{ from: number; to: number; sum: number }> = [];
  for (let from = 0; from < TILE_COUNT; from++) {
    for (let to = 0; to < TILE_COUNT; to++) {
      if (from === to) continue;
      if (!isAdjacent(from, to)) continue;
      moves.push({ from, to, sum: b[to] + b[from] });
    }
  }
  return moves;
}

function applyMoveToBoardForTarget(b: number[], from: number, to: number, refillValue: number, target: number) {
  const next = [...b];
  const sum = b[to] + b[from];
  next[to] = computeToValue(sum, target);
  next[from] = refillValue;
  return { next, sum };
}

function canWinWithinThreeMovesFromInitial(b0: number[], next0: number, next1: number, next2: number, target: number) {
  const moves0 = listAllMovesForTarget(b0);
  for (const first of moves0) {
    const { next: b1, sum: s1 } = applyMoveToBoardForTarget(b0, first.from, first.to, next0, target);
    if (s1 === target) return true;

    const moves1 = listAllMovesForTarget(b1);
    for (const second of moves1) {
      const { next: b2, sum: s2 } = applyMoveToBoardForTarget(b1, second.from, second.to, next1, target);
      if (s2 === target) return true;

      const moves2 = listAllMovesForTarget(b2);
      for (const third of moves2) {
        const { sum: s3 } = applyMoveToBoardForTarget(b2, third.from, third.to, next2, target);
        if (s3 === target) return true;
      }
    }
  }
  return false;
}

function rollFairInitialState(target: number) {
  // Avoid "first player can win within 3 actions" setups.
  let guard = 0;
  while (true) {
    const board = makeInitialBoard();
    const next0 = randInt(1, 9);
    const next1 = randInt(1, 9);
    const next2 = randInt(1, 9);
    if (!canWinWithinThreeMovesFromInitial(board, next0, next1, next2, target)) return { board, next0, next1, next2 };
    guard++;
    if (guard > 5000) return { board, next0, next1, next2 }; // fallback (should be extremely unlikely)
  }
}

function makeNextQueue(first: number, second: number, third: number, length = 80) {
  const q = [first, second, third];
  while (q.length < length) q.push(randInt(1, 9));
  return q;
}

function tileStyle(value: number, target: number): { background: string; boxShadow: string; borderColor: string } {
  const v = Math.max(0, Math.min(target, value));
  const t = v / target;
  const hue = 330 - 250 * t; // pink -> lime
  const sat = 92;
  const light = 72 - t * 10;
  const bg = `hsl(${hue} ${sat}% ${light}%)`;
  const border = `hsl(${hue} ${sat}% ${Math.max(45, light - 22)}%)`;
  const shadow =
    "0 18px 0 rgba(255,255,255,.42) inset, 0 18px 40px rgba(80,60,130,.18), 0 2px 0 rgba(40,30,70,.16)";
  return { background: bg, boxShadow: shadow, borderColor: border };
}

function playerLabel(p: Player) {
  return p === 1 ? "Player 1" : "Player 2";
}

function playerAccent(p: Player) {
  return p === 1 ? "from-sky-400 to-indigo-500" : "from-fuchsia-400 to-rose-500";
}

type ConfettiPiece = {
  id: string;
  left: string;
  delayMs: number;
  durationMs: number;
  sizePx: number;
  rotateDeg: number;
  hue: number;
};

function makeConfetti(count: number): ConfettiPiece[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `${Date.now()}-${i}-${Math.random().toString(16).slice(2)}`,
    left: `${Math.random() * 100}%`,
    delayMs: Math.floor(Math.random() * 300),
    durationMs: 1400 + Math.floor(Math.random() * 1200),
    sizePx: 6 + Math.floor(Math.random() * 8),
    rotateDeg: Math.floor(Math.random() * 360),
    hue: Math.floor(Math.random() * 360),
  }));
}

type MoveOverlay = {
  id: string;
  from: number;
  to: number;
  fromCenter: { x: number; y: number };
  toCenter: { x: number; y: number };
  fusionCenter: { x: number; y: number };
  fromValue: number;
  toValueBefore: number;
  toValueAfter: number;
};

type PlannedMove = {
  from: number;
  to: number;
};

function Icon({
  name,
  className = "h-8 w-8",
}: {
  name: "robot" | "lion" | "peach" | "chick" | "dog" | "warrior" | "lock";
  className?: string;
}) {
  const common = "stroke-zinc-800/70 fill-none stroke-[2.2] stroke-linecap-round stroke-linejoin-round";
  if (name === "lock") {
    return (
      <svg viewBox="0 0 64 64" className={className} aria-hidden="true">
        <path d="M20 30v-6c0-8 6-14 12-14s12 6 12 14v6" className={common} />
        <path
          d="M18 30h28c2 0 4 2 4 4v14c0 2-2 4-4 4H18c-2 0-4-2-4-4V34c0-2 2-4 4-4Z"
          fill="#FFFFFF"
          className="stroke-zinc-800/60 stroke-[2]"
        />
        <path d="M32 38v6" className={common} />
        <path d="M30 38h4" className={common} />
      </svg>
    );
  }
  if (name === "peach") {
    return (
      <svg viewBox="0 0 64 64" className={className} aria-hidden="true">
        <path d="M32 14c-7 0-18 9-18 24 0 12 8 18 18 18s18-6 18-18C50 23 39 14 32 14Z" fill="#FF84B1" />
        <path d="M32 14c-6 2-10 7-12 12" className={common} />
        <path d="M32 22c6-8 12-10 18-10-3 6-8 10-14 12" fill="#5EE28A" className="stroke-zinc-800/60" />
        <path d="M32 22c-4-8-10-10-18-10 3 6 8 10 14 12" fill="#6AE6FF" className="stroke-zinc-800/60" />
        <path d="M26 38h12" className={common} />
        <path d="M26 44c2 2 10 2 12 0" className={common} />
      </svg>
    );
  }
  if (name === "lion") {
    return (
      <svg viewBox="0 0 64 64" className={className} aria-hidden="true">
        <path
          d="M32 10c-10 0-20 8-20 20 0 14 8 24 20 24s20-10 20-24c0-12-10-20-20-20Z"
          fill="#FFB84D"
          className="stroke-zinc-800/60 stroke-[2]"
        />
        <path d="M20 26c-4-2-7-6-8-10 6 1 9 4 12 8" fill="#FF8A4D" className="stroke-zinc-800/50" />
        <path d="M44 26c4-2 7-6 8-10-6 1-9 4-12 8" fill="#FF8A4D" className="stroke-zinc-800/50" />
        <path d="M24 30c2-2 4-2 6 0" className={common} />
        <path d="M34 30c2-2 4-2 6 0" className={common} />
        <path d="M28 38c3 3 5 3 8 0" className={common} />
        <path d="M30 40c0 3 4 3 4 0" className={common} />
      </svg>
    );
  }
  if (name === "robot") {
    return (
      <svg viewBox="0 0 64 64" className={className} aria-hidden="true">
        <path d="M24 10h16v8H24z" fill="#A7F3D0" className="stroke-zinc-800/60 stroke-[2]" />
        <path d="M18 18h28c6 0 10 4 10 10v12c0 8-6 14-14 14H22C14 54 8 48 8 40V28c0-6 4-10 10-10Z" fill="#93C5FD" className="stroke-zinc-800/60 stroke-[2]" />
        <path d="M22 30h8" className={common} />
        <path d="M34 30h8" className={common} />
        <path d="M24 40c4 4 12 4 16 0" className={common} />
        <path d="M32 6v6" className={common} />
        <path d="M30 6h4" className={common} />
      </svg>
    );
  }
  if (name === "chick") {
    return (
      <svg viewBox="0 0 64 64" className={className} aria-hidden="true">
        <path d="M32 14c-10 0-18 8-18 18s8 20 18 20 18-10 18-20-8-18-18-18Z" fill="#FFE66D" className="stroke-zinc-800/60 stroke-[2]" />
        <path d="M26 30h4" className={common} />
        <path d="M34 30h4" className={common} />
        <path d="M30 36h4" className={common} />
        <path d="M30 36l2 3 2-3" fill="#FF8A4D" className="stroke-zinc-800/60 stroke-[2]" />
        <path d="M24 18l4 4" className={common} />
        <path d="M40 18l-4 4" className={common} />
      </svg>
    );
  }
  if (name === "dog") {
    return (
      <svg viewBox="0 0 64 64" className={className} aria-hidden="true">
        <path d="M20 20c0-6 6-10 12-10s12 4 12 10v6c0 10-6 20-12 20S20 36 20 26v-6Z" fill="#F4C7A1" className="stroke-zinc-800/60 stroke-[2]" />
        <path d="M18 22c-6 2-8 8-6 14 6 0 10-4 10-10" fill="#EBAA7E" className="stroke-zinc-800/50 stroke-[2]" />
        <path d="M46 22c6 2 8 8 6 14-6 0-10-4-10-10" fill="#EBAA7E" className="stroke-zinc-800/50 stroke-[2]" />
        <path d="M28 28h4" className={common} />
        <path d="M32 36c0 3-4 3-4 0 0-2 4-2 4 0Z" fill="#FF8A4D" className="stroke-zinc-800/60 stroke-[2]" />
        <path d="M36 28h4" className={common} />
        <path d="M28 40c4 3 8 3 12 0" className={common} />
      </svg>
    );
  }
  // warrior
  return (
    <svg viewBox="0 0 64 64" className={className} aria-hidden="true">
      <path d="M16 26c6-10 26-10 32 0v10c0 10-8 18-16 18s-16-8-16-18V26Z" fill="#C7B9FF" className="stroke-zinc-800/60 stroke-[2]" />
      <path d="M22 22c3-7 17-7 20 0" fill="#7DD3FC" className="stroke-zinc-800/60 stroke-[2]" />
      <path d="M24 30h6" className={common} />
      <path d="M34 30h6" className={common} />
      <path d="M28 40c3 3 5 3 8 0" className={common} />
      <path d="M10 50l12-12" className={common} />
      <path d="M10 50l6 2 2 6" className={common} />
    </svg>
  );
}

function JellyImage({
  src,
  alt,
  ring = "rgba(255,170,210,.95)",
  size = 44,
  disabled,
}: {
  src: string;
  alt: string;
  ring?: string;
  size?: number;
  disabled?: boolean;
}) {
  return (
    <motion.div
      className="relative grid place-items-center rounded-[22px]"
      style={{
        width: size,
        height: size,
        border: `4px solid ${ring}`,
        boxShadow:
          "0 14px 0 rgba(255,255,255,.65) inset, 0 22px 44px rgba(120,70,40,.14), 0 2px 0 rgba(40,30,70,.10)",
        background:
          "radial-gradient(circle at 30% 25%, rgba(255,255,255,.75), rgba(255,255,255,.35) 40%, rgba(255,255,255,.12) 70%)",
        opacity: disabled ? 0.75 : 1,
      }}
      whileHover={
        disabled
          ? undefined
          : {
              rotate: [0, -1.2, 1.2, -0.6, 0],
              y: [0, -1.5, 0],
              transition: { duration: 0.6 },
            }
      }
    >
      <motion.img
        src={src}
        alt={alt}
        className="pointer-events-none select-none"
        style={{
          width: Math.round(size * 0.82),
          height: Math.round(size * 0.82),
          objectFit: "contain",
          filter: disabled ? "grayscale(25%)" : "none",
          transform: "translateY(-2px)",
        }}
        whileHover={disabled ? undefined : { scale: 1.06, y: -2 }}
        transition={{ type: "spring", stiffness: 520, damping: 22 }}
        draggable={false}
      />
      <div
        className="pointer-events-none absolute inset-0 rounded-[22px]"
        style={{
          boxShadow: "0 0 0 1px rgba(255,255,255,.55) inset, 0 -10px 20px rgba(255,255,255,.22) inset",
        }}
      />
    </motion.div>
  );
}

function JellySelectButton({
  selected,
  disabled,
  onClick,
  label,
  subLabel,
  imgSrc,
  imgAlt,
  ring,
  variant = "row",
  imgSize = 46,
}: {
  selected?: boolean;
  disabled?: boolean;
  onClick?: () => void;
  label: string;
  subLabel?: string;
  imgSrc: string;
  imgAlt: string;
  ring: string;
  variant?: "row" | "tile";
  imgSize?: number;
}) {
  return (
    <motion.button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={[
        "group relative whitespace-nowrap border shadow-[0_18px_0_rgba(255,255,255,.7)_inset,0_18px_34px_rgba(90,60,160,.14)] transition-transform",
        variant === "tile"
          ? "flex flex-col items-center justify-center gap-2 rounded-[28px] px-3 py-3 text-center"
          : "flex items-center gap-3 rounded-[28px] px-4 py-3 text-left",
        selected
          ? "border-white bg-gradient-to-r from-amber-200 to-fuchsia-200 text-zinc-800"
          : disabled
            ? "border-white/60 bg-white/55 text-zinc-500 opacity-75"
            : "border-white/70 bg-white/80 text-zinc-700 hover:brightness-105",
        disabled ? "cursor-default" : "active:scale-[0.98]",
      ].join(" ")}
      whileHover={disabled ? undefined : { y: -1 }}
      whileTap={disabled ? undefined : { scale: 0.98, y: 0 }}
      aria-pressed={selected}
    >
      <JellyImage src={imgSrc} alt={imgAlt} ring={ring} size={imgSize} disabled={disabled} />
      <div className={variant === "tile" ? "leading-tight" : "min-w-0"}>
        {variant !== "tile" && subLabel ? (
          <div className="text-[10px] font-black tracking-widest text-zinc-600/90">{subLabel}</div>
        ) : null}
        <div className={variant === "tile" ? "text-xs font-black tracking-tight" : "text-sm font-black tracking-tight"}>
          {label}
        </div>
      </div>
      {disabled && variant !== "tile" ? (
        <span className="ml-auto inline-flex items-center gap-1 rounded-[999px] bg-white/70 px-2 py-1 text-[10px] font-black text-zinc-600 shadow-[0_10px_22px_rgba(90,60,160,.12)]">
          <Icon name="lock" className="h-4 w-4" />
          LOCK
        </span>
      ) : null}
      {disabled && variant === "tile" ? (
        <span className="absolute right-2 top-2 grid h-6 w-6 place-items-center rounded-full bg-white/75 text-zinc-700 shadow-[0_10px_22px_rgba(90,60,160,.12)]">
          <Icon name="lock" className="h-4 w-4" />
        </span>
      ) : null}
    </motion.button>
  );
}

export default function Page() {
  const [screen, setScreen] = useState<Screen>("title");
  const [isPaused, setIsPaused] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [isRuleModalOpen, setIsRuleModalOpen] = useState(false);
  const matchingRunIdRef = useRef(0);

  const [unlockedDifficulties, setUnlockedDifficulties] = useState<CpuDifficulty[]>(["easy", "normal"]);
  const [unlockMessage, setUnlockMessage] = useState<string | null>(null);
  const [showGodVictory, setShowGodVictory] = useState(false);
  const [pendingWinner, setPendingWinner] = useState<Winner>(null);
  const pendingWinnerTimeoutRef = useRef<number | null>(null);
  const [victoryPraise, setVictoryPraise] = useState<string>("");

  // Menu settings (applied on game start)
  const [menuMode, setMenuMode] = useState<GameMode>("cpu");
  const [menuTarget, setMenuTarget] = useState<TargetValue>(DEFAULT_TARGET);
  const [menuFirstTurn, setMenuFirstTurn] = useState<FirstTurn>("random");
  const [menuDifficulty, setMenuDifficulty] = useState<CpuDifficulty>("normal");
  const [menuTimeLimit, setMenuTimeLimit] = useState<TimeLimitChoice>("30");
  const [menuRoomId, setMenuRoomId] = useState<string>("");
  const [menuOnlineRole, setMenuOnlineRole] = useState<OnlineRole>("host");
  const [matchId, setMatchId] = useState<number | null>(null);
  const [matchNotFound, setMatchNotFound] = useState(false);

  // match_type for DB/SEO purposes
  // - "random": ランダム対戦（オンラインのキュー + BOTフォールバック）
  // - "room": ルーム対戦（ID入力によるオンライン対戦）
  const [matchType, setMatchType] = useState<"random" | "room" | null>(null);

  // Rating states (used only for random matches)
  const [playerRate, setPlayerRate] = useState<number>(1500);
  const [opponentRate, setOpponentRate] = useState<number>(1500);
  const [rateLoading, setRateLoading] = useState<boolean>(false);

  // Opponent's user id (presence or BOT fallback)
  const [onlineOpponentUserId, setOnlineOpponentUserId] = useState<string>("");

  // Stats UI states
  const [statsLoading, setStatsLoading] = useState<boolean>(false);
  const [statsError, setStatsError] = useState<string | null>(null);
  const [statsPayload, setStatsPayload] = useState<{
    onlineMatches: number;
    onlineWins: number;
    onlineWinRate: number | null;
    currentRate: number;
    cpuWins: { easy: number; normal: number; hard: number; god: number };
    avgTurnsToGoal25: number | null;
    maxWinStreak: number;
    hasAnyHistory: boolean;
  } | null>(null);

  // 戦績画面の「強制再取得」用（screenが変わらないケースも想定してリフレッシュ）
  const [statsRefreshNonce, setStatsRefreshNonce] = useState(0);

  // BOTレート偽装（表示だけを見せかける）
  const [botDisplayedOpponentRate, setBotDisplayedOpponentRate] = useState<number>(1500);
  const botDisplayGeneratedRef = useRef<boolean>(false);
  const botFakeRateRef = useRef<number>(1500);

  // リザルト画面のレート変動表示（アニメーション用）
  const [resultRateChange, setResultRateChange] = useState<{
    yourBefore: number;
    yourAfter: number;
    opponentBefore: number;
    opponentAfter: number;
    yourDelta: number;
    opponentDelta: number;
  } | null>(null);
  const [resultRateNonce, setResultRateNonce] = useState(0);

  // iPhone 対応：結果モーダル表示直前に最新レートを再取得してから表示するためのゲート
  const [resultModalReady, setResultModalReady] = useState(true);

  const onlineBotFallbackRef = useRef<boolean>(false);

  // Online waiting (room ID sync)
  const [onlineWaitingRoomId, setOnlineWaitingRoomId] = useState<string>("");
  const onlineStartOnceRef = useRef(false);

  // Random match CPU fallback
  const [cpuFallbackMessage, setCpuFallbackMessage] = useState<string | null>(null);
  const randomFallbackTimeoutRef = useRef<number | null>(null);
  const randomMatchResolvedRef = useRef(false);

  // Humanize CPU turns (thought indicator + delay)
  const [cpuThinking, setCpuThinking] = useState(false);

  // Player name (stored locally; used for online presence + UI)
  const [playerName, setPlayerName] = useState<string>(() => `Player_${randInt(1000, 9999)}`);
  const [onlineOpponentName, setOnlineOpponentName] = useState<string>("");
  // Random-match fallback CPU (a.k.a. "online-like" match for UI)
  const [onlineBotFallback, setOnlineBotFallback] = useState<boolean>(false);

  useEffect(() => {
    if (!cpuFallbackMessage) return;
    const id = window.setTimeout(() => setCpuFallbackMessage(null), 2500);
    return () => window.clearTimeout(id);
  }, [cpuFallbackMessage]);

  // Randomマッチ時にレーティングを取得してヘッダー表示に反映する
  useEffect(() => {
    if (matchType !== "random") return;
    if (screen !== "play" && screen !== "onlineWaiting" && screen !== "matching") return;
    const myUserId = getClientId();

    // マッチング中は相手 userId がまだ無いので、自分のレートだけ先に取得して UI を確実に表示する
    if (screen === "matching" && !onlineOpponentUserId) {
      if (hasFetchedMyRateForMatchRef.current) return;
      hasFetchedMyRateForMatchRef.current = true;
      setRateLoading(true);
      void (async () => {
        try {
          const myRate = await getOrCreatePlayerRating(myUserId);
          setPlayerRate(myRate);
        } finally {
          setRateLoading(false);
        }
      })();
      return;
    }

    if (hasFetchedRatesForMatchRef.current) return;
    if (!onlineOpponentUserId) return; // online/ボット共通で相手 userId が必要

    hasFetchedRatesForMatchRef.current = true;
    setRateLoading(true);
    void (async () => {
      const oppUserId = onlineOpponentUserId;
      try {
        const [myRate, oppRate] = await Promise.all([getOrCreatePlayerRating(myUserId), getOrCreatePlayerRating(oppUserId)]);
        setPlayerRate(myRate);
        setOpponentRate(oppRate);
      } finally {
        setRateLoading(false);
      }
    })();
  }, [matchType, screen, onlineOpponentUserId]);

  useEffect(() => {
    // BOTの場合は「表示だけ」それっぽいレートに偽装します（DBの Elo はそのまま）。
    if (!onlineBotFallback) return;
    if (matchType !== "random") return;
    if (rateLoading) return;
    if (botDisplayGeneratedRef.current) return;

    const min = Math.max(0, playerRate - 50);
    const max = playerRate + 50;
    const fake = randInt(min, max);
    setBotDisplayedOpponentRate(fake);
    // Elo計算にも偽装レートを使うため、state自体も反映する
    setOpponentRate(fake);
    botFakeRateRef.current = fake;
    botDisplayGeneratedRef.current = true;
  }, [onlineBotFallback, matchType, rateLoading, playerRate]);

  // 戦績（スタッツ）画面：DBから対戦履歴を取得→集計して表示
  useEffect(() => {
    if (screen !== "stats") return;

    setStatsError(null);
    setStatsPayload(null);
    setStatsLoading(true);

    void (async () => {
      const userId = getClientId();

      try {
        // 1) 現在の Elo（user_id のレコードから取得。無ければ 1500）
        const { data: ratingRow } = await supabase
          .from("player_ratings")
          .select("user_id,rating")
          .eq("user_id", userId)
          .maybeSingle<PlayerRatingRow>();

        const currentRate = ratingRow?.rating && Number.isFinite(ratingRow.rating) ? Math.round(ratingRow.rating) : 1500;

        // 2) 自分が関わった match_history を取得
        //    Supabase では OR 文字列が分かりにくいので、player1/player2 を分けて取得→結合します。
        // `turns_to_goal25` 列がまだ DB に存在しない可能性があるため、
        // 先に取得を試して、失敗した場合は列を省略して再取得します。
        const [h1, h2] = await Promise.all([
          supabase
            .from("match_history")
            .select("id,player1_id,player2_id,winner_id,turns,match_type,turns_to_goal25,created_at")
            .eq("player1_id", userId),
          supabase
            .from("match_history")
            .select("id,player1_id,player2_id,winner_id,turns,match_type,turns_to_goal25,created_at")
            .eq("player2_id", userId),
        ]);

        let rows1 = (h1.data ?? []) as MatchHistoryRow[];
        let rows2 = (h2.data ?? []) as MatchHistoryRow[];

        if (h1.error || h2.error) {
          const [h1b, h2b] = await Promise.all([
            supabase
              .from("match_history")
              .select("id,player1_id,player2_id,winner_id,turns,match_type,created_at")
              .eq("player1_id", userId),
            supabase
              .from("match_history")
              .select("id,player1_id,player2_id,winner_id,turns,match_type,created_at")
              .eq("player2_id", userId),
          ]);
          rows1 = (h1b.data ?? []) as MatchHistoryRow[];
          rows2 = (h2b.data ?? []) as MatchHistoryRow[];
        }

        // 2重取得の可能性が低い想定だが、万一に備えて id を見て重複除去する
        const byId = new Map<number | string, MatchHistoryRow>();
        for (const r of [...rows1, ...rows2]) {
          const key = r.id ?? `${r.player1_id}-${r.player2_id}-${r.created_at}`;
          byId.set(key, r);
        }

        const history = Array.from(byId.values());

        if (history.length === 0) {
          setStatsPayload({
            onlineMatches: 0,
            onlineWins: 0,
            onlineWinRate: null,
            currentRate,
            cpuWins: { easy: 0, normal: 0, hard: 0, god: 0 },
            avgTurnsToGoal25: null,
            maxWinStreak: 0,
            hasAnyHistory: false,
          });
          return;
        }

        // --- A. オンライン（random / room） ---
        const onlineRows = history.filter((r) => r.match_type === "random" || r.match_type === "room");
        const onlineMatches = onlineRows.length;
        const onlineWins = onlineRows.filter((r) => r.winner_id === userId).length;
        const onlineWinRate = onlineMatches > 0 ? Math.round((onlineWins / onlineMatches) * 1000) / 10 : null;

        // --- B. CPU 勝利数（match_type = cpu_easy...） ---
        const cpuWins = {
          easy: history.filter((r) => r.match_type === "cpu_easy" && r.winner_id === userId).length,
          normal: history.filter((r) => r.match_type === "cpu_normal" && r.winner_id === userId).length,
          hard: history.filter((r) => r.match_type === "cpu_hard" && r.winner_id === userId).length,
          god: history.filter((r) => r.match_type === "cpu_god" && r.winner_id === userId).length,
        };

        // --- C. プレイスタイル ---
        // 25 を作るまでのターン数（turns_to_goal25）が入っている試合だけ平均する。
        // ただし「自分が勝利した試合（winner_id === 自身のユーザーID）」のみを対象にする。
        const wonHistory = history.filter((r) => r.winner_id === userId);
        const turnsToGoal25Values = wonHistory
          .map((r) => r.turns_to_goal25)
          .filter((v): v is number => typeof v === "number" && Number.isFinite(v) && v > 0);

        const avgTurnsToGoal25 =
          turnsToGoal25Values.length > 0
            ? Math.round((turnsToGoal25Values.reduce((a, b) => a + b, 0) / turnsToGoal25Values.length) * 10) / 10
            : null;

        // 最大連勝数（勝利した試合が連続して続く区間）
        const ordered = [...history].sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
        let streak = 0;
        let maxWinStreak = 0;
        for (const r of ordered) {
          if (r.winner_id === userId) {
            streak += 1;
            maxWinStreak = Math.max(maxWinStreak, streak);
          } else {
            streak = 0;
          }
        }

        setStatsPayload({
          onlineMatches,
          onlineWins,
          onlineWinRate,
          currentRate,
          cpuWins,
          avgTurnsToGoal25,
          maxWinStreak,
          hasAnyHistory: true,
        });
      } catch {
        setStatsError("データの取得に失敗しました。時間をおいて再度お試しください。");
      } finally {
        setStatsLoading(false);
      }
    })();
  }, [screen, statsRefreshNonce]);

  const [bgmMuted, setBgmMuted] = useState<boolean>(false);
  const [seMuted, setSeMuted] = useState<boolean>(false);

  // Active game settings
  const [target, setTarget] = useState<number>(DEFAULT_TARGET);
  const [board, setBoard] = useState<number[]>(() => makeInitialBoard());
  const [nextQueue, setNextQueue] = useState<number[]>(() => Array.from({ length: 80 }, () => randInt(1, 9)));
  const [nextIndex, setNextIndex] = useState(0);
  const [nextNumber, setNextNumber] = useState<number>(() => randInt(1, 9));
  const [currentPlayer, setCurrentPlayer] = useState<Player>(1);
  const [startingPlayer, setStartingPlayer] = useState<Player>(1);
  const [movesLeft, setMovesLeft] = useState<number>(TURN_ACTIONS);
  // "turns" = ゲーム終了までに進んだターン数（1ターン = 3アクションの塊）
  // 記録/保存用。オンラインでは Authoritative state と一緒に同期する。
  const [turns, setTurns] = useState<number>(1);
  const [mode, setMode] = useState<GameMode>("cpu");
  const [cpuDifficulty, setCpuDifficulty] = useState<CpuDifficulty>("normal");
  const [online, setOnline] = useState<OnlineState | null>(null);
  const [timeLimitMs, setTimeLimitMs] = useState<number | null>(30_000);
  const [actionDeadlineMs, setActionDeadlineMs] = useState<number | null>(null);
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  const [selected, setSelected] = useState<number | null>(null);
  const [winner, setWinner] = useState<Winner>(null);
  const [flashIndex, setFlashIndex] = useState<number | null>(null);
  const [confetti, setConfetti] = useState<ConfettiPiece[]>([]);
  const [moveOverlay, setMoveOverlay] = useState<MoveOverlay | null>(null);
  const [isAnimatingMove, setIsAnimatingMove] = useState(false);
  const [bumpIds, setBumpIds] = useState<number[]>(() => Array.from({ length: TILE_COUNT }, () => 0));

  const flashTimeoutRef = useRef<number | null>(null);
  const boardWrapRef = useRef<HTMLDivElement | null>(null);
  const tileRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const prefersReducedMotion = useReducedMotion();
  const completedOverlayIdRef = useRef<string | null>(null);
  const touchStartRef = useRef<{ idx: number; x: number; y: number } | null>(null);

  const boardRef = useRef<number[]>(board);
  const nextQueueRef = useRef<number[]>(nextQueue);
  const nextIndexRef = useRef<number>(nextIndex);
  const nextNumberRef = useRef<number>(nextNumber);
  const currentPlayerRef = useRef<Player>(currentPlayer);
  const movesLeftRef = useRef<number>(movesLeft);
  const turnsRef = useRef<number>(turns);
  // 盤面上に「25」が初めて登場したタイミング（概算のターン数）
  // スタッツの「25を作るまでの平均ターン数」用。
  const turnsToGoal25Ref = useRef<number | null>(null);
  const modeRef = useRef<GameMode>(mode);
  const cpuDifficultyRef = useRef<CpuDifficulty>(cpuDifficulty);
  const targetRef = useRef<number>(target);
  const winnerRef = useRef<Winner>(winner);
  const pendingWinnerRef = useRef<Winner>(pendingWinner);
  const timeLimitMsRef = useRef<number | null>(timeLimitMs);
  // オンライン対戦時の「相手ターン中は自分側タイマーを進めない」ための固定表示用
  const frozenTimeLeftMsRef = useRef<number | null>(null);
  // 遅延 Realtime 通知（残像）を捨てるための「ターンの壁」
  const turnWallUntilRef = useRef<number>(0);
  const wasMyTurnRef = useRef<boolean>(false);
  const matchTypeRef = useRef<"random" | "room" | null>(matchType);
  const cpuTimeoutRef = useRef<number | null>(null);
  const cpuPlannedLineRef = useRef<PlannedMove[] | null>(null);
  const onlineChannelRef = useRef<RealtimeChannel | null>(null);
  const onlineClientIdRef = useRef<string>("");
  const matchChannelRef = useRef<RealtimeChannel | null>(null);
  const matchIdRef = useRef<number | null>(matchId);
  const isProcessingRef = useRef<boolean>(isProcessing);
  const hasFetchedRatesForMatchRef = useRef<boolean>(false);
  const hasFetchedMyRateForMatchRef = useRef<boolean>(false);
  const hasPersistedMatchRef = useRef<boolean>(false);
  const playerRateRef = useRef<number>(playerRate);
  const opponentRateRef = useRef<number>(opponentRate);

  // Audio management
  const bgmAudioRef = useRef<HTMLAudioElement | null>(null);
  const seAudioCacheRef = useRef<Record<string, HTMLAudioElement>>({});
  const bgmTriedRef = useRef(false);

  // Web Audio API (iOS 対応: volume property が効かないため GainNode 経由に切り替え)
  const audioCtxRef = useRef<AudioContext | null>(null);
  const bgmGainRef = useRef<GainNode | null>(null);
  const seMasterGainRef = useRef<GainNode | null>(null);
  const bgmSourceNodeRef = useRef<MediaElementAudioSourceNode | null>(null);
  const seSourceNodesRef = useRef<Record<string, MediaElementAudioSourceNode>>({});
  const seSoundGainNodesRef = useRef<Record<string, GainNode>>({});

  useEffect(() => {
    boardRef.current = board;
  }, [board]);
  useEffect(() => {
    nextQueueRef.current = nextQueue;
  }, [nextQueue]);
  useEffect(() => {
    nextIndexRef.current = nextIndex;
  }, [nextIndex]);
  useEffect(() => {
    nextNumberRef.current = nextNumber;
  }, [nextNumber]);
  useEffect(() => {
    currentPlayerRef.current = currentPlayer;
  }, [currentPlayer]);
  useEffect(() => {
    movesLeftRef.current = movesLeft;
  }, [movesLeft]);

  useEffect(() => {
    turnsRef.current = turns;
  }, [turns]);

  useEffect(() => {
    playerRateRef.current = playerRate;
  }, [playerRate]);

  useEffect(() => {
    opponentRateRef.current = opponentRate;
  }, [opponentRate]);

  useEffect(() => {
    onlineBotFallbackRef.current = onlineBotFallback;
  }, [onlineBotFallback]);

  useEffect(() => {
    // 新しいゲーム開始時（screen が play になった瞬間）に 25 記録をリセット
    if (screen === "play") turnsToGoal25Ref.current = null;
  }, [screen]);

  useEffect(() => {
    // winner が決まった後は「25を作るまで」の計測は確定している想定なので変更しない。
    if (screen !== "play") return;
    if (winner) return;
    if (turnsToGoal25Ref.current !== null) return;
    if (!board.includes(25)) return;

    // 盤面に 25 が初めて出た時点の turn を記録（概算）
    turnsToGoal25Ref.current = turnsRef.current;
  }, [board, screen, winner]);
  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);
  useEffect(() => {
    matchTypeRef.current = matchType;
  }, [matchType]);
  useEffect(() => {
    cpuDifficultyRef.current = cpuDifficulty;
  }, [cpuDifficulty]);
  useEffect(() => {
    timeLimitMsRef.current = timeLimitMs;
  }, [timeLimitMs]);

  useEffect(() => {
    // Restore mute settings
    try {
      const bgmRaw = localStorage.getItem("plusBattleBgmMuted");
      const seRaw = localStorage.getItem("plusBattleSeMuted");
      if (bgmRaw === "1") setBgmMuted(true);
      if (seRaw === "1") setSeMuted(true);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    // Restore saved player name
    try {
      const raw = localStorage.getItem("plusBattlePlayerName");
      const v = (raw ?? "").trim();
      if (v) setPlayerName(v.slice(0, 16));
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    // Persist player name
    try {
      localStorage.setItem("plusBattlePlayerName", playerName);
    } catch {
      // ignore
    }
  }, [playerName]);

  useEffect(() => {
    try {
      localStorage.setItem("plusBattleBgmMuted", bgmMuted ? "1" : "0");
      localStorage.setItem("plusBattleSeMuted", seMuted ? "1" : "0");
    } catch {
      // ignore
    }
  }, [bgmMuted, seMuted]);

  useEffect(() => {
    // Init BGM + SE assets once
    const bgm = new Audio("/music/bgm.mp3");
    bgm.loop = true;
    bgm.preload = "auto";
    // iOS: 実際の音量は Web Audio の GainNode 側で制御する
    bgm.volume = 1;
    bgmAudioRef.current = bgm;

    // Pre-cache SE audio objects
    const seFiles: Array<[string, string]> = [
      ["sentaku", "/sounds/sentaku.mp3"],
      ["susumu", "/sounds/susumu.mp3"],
      ["modoru", "/sounds/modoru.mp3"],
      ["yuugou1", "/sounds/yuugou1.mp3"],
      ["yuugou2", "/sounds/yuugou2.mp3"],
      ["make", "/sounds/make.mp3"],
      ["win", "/sounds/win.mp3"],
      ["godwin", "/sounds/godwin.mp3"],
    ];
    seFiles.forEach(([k, url]) => {
      const a = new Audio(url);
      a.preload = "auto";
      // iOS: 実際の音量は Web Audio の GainNode 側で制御する
      a.volume = 1;
      seAudioCacheRef.current[k] = a;
    });
    // Try to start BGM immediately (may be blocked by browser, so it's safe to ignore)
    return () => {
      bgmAudioRef.current?.pause();
    };
  }, []);

  useEffect(() => {
    // iOS 互換: volume ではなく muted を切り替える
    if (bgmAudioRef.current) bgmAudioRef.current.muted = bgmMuted;
    Object.values(seAudioCacheRef.current).forEach((a) => {
      a.muted = seMuted;
    });
  }, [bgmMuted, seMuted]);

  function ensureAudioGraph() {
    if (typeof window === "undefined") return;
    const AudioCtx =
      window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;
    if (!audioCtxRef.current) {
      audioCtxRef.current = new AudioCtx();
      bgmGainRef.current = audioCtxRef.current.createGain();
      seMasterGainRef.current = audioCtxRef.current.createGain();
      // muted 方式を採用するため、基準ゲインは固定 1.0
      bgmGainRef.current.gain.value = 1;
      seMasterGainRef.current.gain.value = 1;
      bgmGainRef.current.connect(audioCtxRef.current.destination);
      seMasterGainRef.current.connect(audioCtxRef.current.destination);
    }

    // BGM 接続
    if (bgmAudioRef.current && bgmGainRef.current && audioCtxRef.current && !bgmSourceNodeRef.current) {
      try {
        bgmSourceNodeRef.current = audioCtxRef.current.createMediaElementSource(bgmAudioRef.current);
        bgmSourceNodeRef.current.connect(bgmGainRef.current);
      } catch {
        // ignore
      }
    }

    // SE 接続
    if (seMasterGainRef.current && audioCtxRef.current) {
      Object.entries(seAudioCacheRef.current).forEach(([k, a]) => {
        if (!a) return;
        if (seSourceNodesRef.current[k]) return;
        try {
          const src = audioCtxRef.current!.createMediaElementSource(a);
          const soundGain = audioCtxRef.current!.createGain();
          soundGain.gain.value = SE_GAINS[k] ?? 1;
          src.connect(soundGain);
          soundGain.connect(seMasterGainRef.current!);
          seSourceNodesRef.current[k] = src;
          seSoundGainNodesRef.current[k] = soundGain;
        } catch {
          // ignore
        }
      });
    }
  }

  async function resumeAudioContext() {
    ensureAudioGraph();
    const ctx = audioCtxRef.current;
    if (!ctx) return;
    if (ctx.state === "suspended") {
      try {
        await ctx.resume();
      } catch {
        // ignore
      }
    }
  }

  useEffect(() => {
    // iOS Safari は最初のユーザー操作まで AudioContext を resume できないため、
    // 最初のタップで必ず resume する（以後は once で無視）
    const onFirstGesture = () => {
      void resumeAudioContext();
    };
    window.addEventListener("pointerdown", onFirstGesture, { once: true });
    return () => window.removeEventListener("pointerdown", onFirstGesture);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function startBgm() {
    // iOS Safari: ユーザー操作後に AudioContext を resume する必要があるため、
    // 再生直前に resume を試みる
    await resumeAudioContext();
    if (!bgmAudioRef.current) return;
    try {
      const audio = bgmAudioRef.current;
      // If BGM already started, do not seek to 0 (avoid restart bug).
      if (!bgmTriedRef.current || audio.currentTime === 0) {
        audio.currentTime = 0;
      }
      bgmTriedRef.current = true;
      await bgmAudioRef.current.play();
    } catch {
      // ignore
    }
  }

  function playSe(
    key: "sentaku" | "susumu" | "modoru" | "yuugou1" | "yuugou2" | "make" | "win" | "godwin",
  ) {
    // iOS Safari: context が suspended の場合は resume してから再生する
    void resumeAudioContext().then(() => {
      const a = seAudioCacheRef.current[key];
      if (!a) return;
      try {
        a.currentTime = 0;
        void a.play().catch(() => {
          // ignore
        });
      } catch {
        // ignore
      }
    });
  }

  function playRandomYuugou() {
    const pick = Math.random() < 0.5 ? "yuugou1" : "yuugou2";
    playSe(pick);
  }

  useEffect(() => {
    // Best-effort: browsers may block autoplay, so it's safe to ignore failures.
    void startBgm();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    isProcessingRef.current = isProcessing;
  }, [isProcessing]);

  useEffect(() => {
    try {
      const raw = localStorage.getItem("plusBattleUnlockedDifficulties");
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return;
      const valid = parsed.filter((d) => d === "easy" || d === "normal" || d === "hard" || d === "god") as CpuDifficulty[];
      const uniq = Array.from(new Set(valid));
      if (uniq.length > 0) setUnlockedDifficulties(uniq);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem("plusBattleUnlockedDifficulties", JSON.stringify(unlockedDifficulties));
    } catch {
      // ignore
    }
  }, [unlockedDifficulties]);

  useEffect(() => {
    if (!unlockedDifficulties.includes(menuDifficulty)) {
      setMenuDifficulty(unlockedDifficulties.includes("normal") ? "normal" : "easy");
    }
  }, [menuDifficulty, unlockedDifficulties]);
  useEffect(() => {
    targetRef.current = target;
  }, [target]);
  useEffect(() => {
    winnerRef.current = winner;
  }, [winner]);
  useEffect(() => {
    pendingWinnerRef.current = pendingWinner;
  }, [pendingWinner]);
  useEffect(() => {
    matchIdRef.current = matchId;
  }, [matchId]);

  useEffect(() => {
    if (!isPaused) return;
    if (cpuTimeoutRef.current) window.clearTimeout(cpuTimeoutRef.current);
    setSelected(null);
  }, [isPaused]);

  useEffect(() => {
    // タイマー表示（timeLeftMs）のための nowMs 更新。
    // ターンごとに setInterval を増殖させないよう、開始条件/cleanup を useEffect 側で一元管理します。
    const shouldTickNow =
      screen === "play" &&
      !isPaused &&
      !winner &&
      (mode !== "online" || (!!online && online.player === currentPlayer));
    if (!shouldTickNow) return;
    const t = window.setInterval(() => setNowMs(Date.now()), 120);
    return () => window.clearInterval(t);
  }, [screen, isPaused, winner, mode, online, currentPlayer]);

  useEffect(() => {
    // オンライン対戦のタイマー同期（ターン壁）
    // - 自分のターン開始時に movesLeft/タイマーを強制リセット
    // - 相手のターン中は自分側タイマーが減らないよう表示を固定
    if (screen !== "play") return;
    if (mode !== "online") return;
    if (!online) return;
    if (isPaused || winner) return;
    if (pendingWinnerRef.current) return;

    const myTurn = online.player === currentPlayer;
    const prevMyTurn = wasMyTurnRef.current;

    // 自分のターンに切り替わった瞬間
    if (myTurn && !prevMyTurn) {
      // ターン壁: 遅延した opponent broadcast の残像（movesLeft の不正減算など）を短時間捨てる
      turnWallUntilRef.current = Date.now() + 600;

      // 明示的に「残り3回」を強制（UI の誤認を確実に防ぐ）
      movesLeftRef.current = TURN_ACTIONS;
      setMovesLeft(TURN_ACTIONS);

      // タイマーもターン開始時に規定秒数で上書き
      const limit = timeLimitMsRef.current;
      const deadline = limit === null ? null : Date.now() + limit;
      setActionDeadlineMs(deadline);
      // 相手ターン中の表示固定用
      frozenTimeLeftMsRef.current = limit === null ? null : limit;
    }

    // 相手のターンに切り替わった瞬間（表示だけ固定）
    if (!myTurn && prevMyTurn) {
      frozenTimeLeftMsRef.current =
        actionDeadlineMs === null ? null : Math.max(0, actionDeadlineMs - Date.now());
    }

    wasMyTurnRef.current = myTurn;
  }, [actionDeadlineMs, currentPlayer, isPaused, mode, online, pendingWinner, screen, winner]);

  // pendingWinner が非 null の間は「勝敗演出待ち」なので、CPUの思考/自動操作を止める
  const isCpuTurn =
    mode === "cpu" && currentPlayer === 2 && winner === null && pendingWinner === null && screen === "play" && !isPaused;

  const nextPair = useMemo(() => {
    const q = nextQueue;
    const idx = nextIndex;
    const n0 = q[idx] ?? nextNumber;
    const n1 = q[idx + 1] ?? randInt(1, 9);
    return { n0, n1 };
  }, [nextIndex, nextNumber, nextQueue]);
  const isOnlineLocked = mode === "online" && (!online || !online.ready || online.player !== currentPlayer);
  const canInteract =
    winner === null &&
    pendingWinner === null &&
    !isProcessing &&
    !isAnimatingMove &&
    (!isCpuTurn) &&
    !isOnlineLocked &&
    screen === "play" &&
    !isPaused;

  const isOpponentTurn = useMemo(() => {
    if (screen !== "play" || isPaused || winner) return false;
    if (mode === "cpu") return currentPlayer === 2;
    if (mode === "online") return !!online && online.player !== currentPlayer;
    return false;
  }, [screen, isPaused, winner, mode, currentPlayer, online]);

  const showThinking = isOpponentTurn && (mode === "cpu" ? cpuThinking : true);

  // online戦（ルーム/ランダム共通）時のUI切替用
  // ※ランダムでBOTになった場合も menuMode が "online" になるので、ここで同じUI扱いにする
  const isOnlineBattle = menuMode === "online" && screen === "play";

  // 表示用の相手レート（BOTは UI だけ偽装する）
  const opponentRateForDisplay = onlineBotFallback && matchType === "random" ? botDisplayedOpponentRate : opponentRate;

  const onlineRoleLabel = useMemo(() => {
    const myRole = menuOnlineRole;
    const myText = myRole === "host" ? "ホスト" : "ゲスト";
    const oppText = myRole === "host" ? "ゲスト" : "ホスト";
    return { myText, oppText };
  }, [menuOnlineRole]);

  const movesLeftText = useMemo(() => {
    if (winner) return "";
    return `のこり手数：${movesLeft}`;
  }, [movesLeft, winner]);

  const timeLeftMs = useMemo<number | null>(() => {
    if (screen !== "play" || isPaused || winner) return 0;
    const computed = actionDeadlineMs === null ? null : Math.max(0, actionDeadlineMs - nowMs);

    // オンライン対戦で「相手ターン中」は自分側タイマーが勝手に減るのを防ぐ
    // （ターン壁: delayed broadcast の残像で表示だけズレるのを抑える）
    if (mode === "online" && online && online.player !== currentPlayer) {
      return frozenTimeLeftMsRef.current ?? computed;
    }

    return computed;
  }, [actionDeadlineMs, currentPlayer, isPaused, mode, nowMs, online, screen, winner]);

  const timeLeftSec = useMemo(() => (timeLeftMs === null ? null : Math.ceil(timeLeftMs / 1000)), [timeLeftMs]);

  function choiceToMs(choice: TimeLimitChoice): number | null {
    if (choice === "3") return 3_000;
    if (choice === "15") return 15_000;
    if (choice === "30") return 30_000;
    return null;
  }

  const mergeAnim = useMemo(() => {
    if (!moveOverlay) return null;
    const tileHalf = 48; // h-24 w-24
    const fromTL = { x: moveOverlay.fromCenter.x - tileHalf, y: moveOverlay.fromCenter.y - tileHalf };
    const toTL = { x: moveOverlay.toCenter.x - tileHalf, y: moveOverlay.toCenter.y - tileHalf };
    const fusionTL = { x: moveOverlay.fusionCenter.x - tileHalf, y: moveOverlay.fusionCenter.y - tileHalf };

    const dx = moveOverlay.toCenter.x - moveOverlay.fromCenter.x;
    const dy = moveOverlay.toCenter.y - moveOverlay.fromCenter.y;
    const len = Math.max(1, Math.hypot(dx, dy));
    const ux = dx / len;
    const uy = dy / len;

    const prePushPx = 7;
    const wobblePx = 6;
    const rotateDeg = Math.max(-10, Math.min(10, ux * 10));

    return { fromTL, toTL, fusionTL, ux, uy, prePushPx, wobblePx, rotateDeg };
  }, [moveOverlay]);

  function getClientId() {
    if (typeof window === "undefined") return "server";
    const k = "plus-battle-client-id";
    const existing = window.localStorage.getItem(k);
    if (existing) return existing;
    const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    window.localStorage.setItem(k, id);
    return id;
  }

  /**
   * Supabase から「そのユーザーの現在レート」を取得し、無ければ初期値(1500)で作成します。
   * 初回ログインや BOT などで行が存在しないケースに対応するため、
   * get-or-create（取得→無ければ作成）をこの関数に閉じ込めます。
   */
  async function getOrCreatePlayerRating(userId: string): Promise<number> {
    const initialRating = 1500;
    if (!userId) return initialRating;

    // まずは既存行を検索
    const { data, error } = await supabase
      .from("player_ratings")
      .select("user_id,rating")
      .eq("user_id", userId)
      .maybeSingle<PlayerRatingRow>();

    if (error) {
      // DBエラーがあってもゲーム自体は止めたくないので初期値で進行
      const err = error as unknown as SupabaseErrorLike;
      console.error(
        "[player_ratings select failed]",
        safeStringify({
          message: err.message,
          details: err.details,
          hint: err.hint,
          status: err.status,
          code: err.code,
        }),
        { userId },
      );
      return initialRating;
    }

    if (data && typeof data.rating === "number" && Number.isFinite(data.rating)) {
      return Math.round(data.rating);
    }

    // 存在しない場合は初期値で作成（upsertで競合も吸収）
    const { error: upsertError } = await supabase
      .from("player_ratings")
      .upsert({ user_id: userId, rating: initialRating } as unknown as Pick<PlayerRatingRow, "user_id" | "rating">, {
        onConflict: "user_id",
      });

    if (upsertError) {
      const err = upsertError as unknown as SupabaseErrorLike;
      console.error(
        "[player_ratings upsert failed]",
        safeStringify({
          message: err.message,
          details: err.details,
          hint: err.hint,
          status: err.status,
          code: err.code,
        }),
        { userId, initialRating },
      );
      return initialRating;
    }

    return initialRating;
  }

  /**
   * Supabase の player_ratings を新しいレートに更新します。
   * Elo 計算は「ランダム対戦」だけで行うため、この関数は match_type が random の時に呼びます。
   */
  async function upsertPlayerRating(userId: string, newRating: number) {
    if (!userId) return;
    const { error } = await supabase
      .from("player_ratings")
      .upsert({ user_id: userId, rating: newRating } as unknown as Pick<PlayerRatingRow, "user_id" | "rating">, {
        onConflict: "user_id",
      });
    if (error) {
      const err = error as unknown as SupabaseErrorLike;
      console.error(
        "[player_ratings upsert failed]",
        safeStringify({
          message: err.message,
          details: err.details,
          hint: err.hint,
          status: err.status,
          code: err.code,
        }),
        { userId, newRating },
      );
      throw error;
    }
  }

  /**
   * 1試合分の履歴を match_history に INSERT します。
   * rating 更新とは独立に「対戦が終わった事実」を保存するのが目的です。
   */
  async function insertMatchHistory(row: MatchHistoryInsert) {
    // Supabase/DB が受け付けない列（存在しないキー）を減らすため、
    // undefined は送らない（null は「値あり」として扱う）。
    const rowClean = Object.fromEntries(Object.entries(row).filter(([, v]) => v !== undefined));

    const { error } = await supabase.from("match_history").insert(rowClean as Record<string, unknown>);
    if (error) {
      const err = error as unknown as SupabaseErrorLike;
      console.error(
        "[match_history insert failed]",
        safeStringify({
          message: err.message,
          details: err.details,
          hint: err.hint,
          status: err.status,
          code: err.code,
        }),
      );
      console.error("[match_history insert payload]", safeStringify(rowClean));
      throw error;
    }
  }

  async function leaveOnlineRoom() {
    if (onlineChannelRef.current) {
      await supabase.removeChannel(onlineChannelRef.current);
      onlineChannelRef.current = null;
    }
    setOnline(null);
    setOnlineOpponentName("");
    setOnlineOpponentUserId("");
    setOnlineBotFallback(false);
    setBotDisplayedOpponentRate(1500);
    botDisplayGeneratedRef.current = false;
    setResultRateChange(null);
    setResultRateNonce((n) => n + 1);
  }

  async function leaveMatchChannel() {
    if (matchChannelRef.current) {
      await supabase.removeChannel(matchChannelRef.current);
      matchChannelRef.current = null;
    }
  }

  async function cleanupMatchRecord() {
    const id = matchIdRef.current;
    if (!id) return;
    try {
      await supabase.from("public_matches").delete().eq("id", id);
    } catch {
      // best-effort
    }
    setMatchId(null);
  }

  async function cancelMatchingAndBackToMenu() {
    matchingRunIdRef.current += 1; // cancel any in-flight matching loop
    playSe("modoru");
    if (randomFallbackTimeoutRef.current) {
      window.clearTimeout(randomFallbackTimeoutRef.current);
      randomFallbackTimeoutRef.current = null;
    }
    setCpuFallbackMessage(null);
    await cleanupMatchRecord();
    await leaveMatchChannel();
    await leaveOnlineRoom();
    setMatchNotFound(false);
    setMatchType(null);
    setRateLoading(false);
    setPlayerRate(1500);
    setOpponentRate(1500);
    setScreen("menu");
  }

  useEffect(() => {
    function onUnload() {
      // best-effort cleanup so waiting records don't stick around
      void cleanupMatchRecord();
      void leaveOnlineRoom();
    }
    window.addEventListener("beforeunload", onUnload);
    return () => {
      window.removeEventListener("beforeunload", onUnload);
      if (randomFallbackTimeoutRef.current) {
        window.clearTimeout(randomFallbackTimeoutRef.current);
        randomFallbackTimeoutRef.current = null;
      }
    };
  }, []);

  function genRoomId() {
    return Math.random().toString(36).slice(2, 8);
  }

  async function startRandomMatch() {
    playSe("susumu");
    const runId = matchingRunIdRef.current + 1;
    matchingRunIdRef.current = runId;

    // random match は常に30秒（UI文言/タイマー整合）
    setTimeLimitMs(30_000);
    setMatchType("random");
    setCpuThinking(false);
    hasFetchedRatesForMatchRef.current = false;
    hasFetchedMyRateForMatchRef.current = false;
    hasPersistedMatchRef.current = false;
    setRateLoading(true);
    setResultRateChange(null);
    setResultRateNonce((n) => n + 1);
    setPlayerRate(1500);
    setOpponentRate(1500);
    setOnlineBotFallback(false);
    setCpuFallbackMessage(null);
    setOnlineOpponentName("");
    setMenuMode("online");
    setScreen("matching");
    setMatchNotFound(false);
    setMatchId(null);
    onlineStartOnceRef.current = false;
    randomMatchResolvedRef.current = false;

    // 15秒成立しなければ必ずBOTへフォールバック
    const snapshotTarget = menuTarget;
    if (randomFallbackTimeoutRef.current) {
      window.clearTimeout(randomFallbackTimeoutRef.current);
      randomFallbackTimeoutRef.current = null;
    }

    randomFallbackTimeoutRef.current = window.setTimeout(() => {
      if (matchingRunIdRef.current !== runId) return;
      randomFallbackTimeoutRef.current = null;
      // オンライン開始済みならフォールバックしない（念のため）
      if (randomMatchResolvedRef.current) return;

      void (async () => {
        matchingRunIdRef.current += 1; // in-flight matching stop
        await cleanupMatchRecord();
        await leaveMatchChannel();
        await leaveOnlineRoom();

        const fallbackCpu: CpuDifficulty = Math.random() < 0.5 ? "normal" : "hard";
        const dummyOpponent = `Player_${randInt(1000, 9999)}`;
        // BOTは「疑似ユーザー」として Supabase 上でも rating を持てるように userId を別で作る
        const dummyOpponentUserId = `bot_${dummyOpponent}`;

        randomMatchResolvedRef.current = true;
        setCpuFallbackMessage("対戦相手が見つかりました！");
        setOnlineOpponentName(dummyOpponent);
        setOnlineOpponentUserId(dummyOpponentUserId);
        setOnlineBotFallback(true);
        botDisplayGeneratedRef.current = false;
        setBotDisplayedOpponentRate(1500);
        setTarget(snapshotTarget);
        setMode("cpu"); // CPUロジックをそのまま使う（UIはonline扱い）
        setCpuDifficulty(fallbackCpu);
        setStartingPlayer(1);
        setCurrentPlayer(1);
        setMovesLeft(TURN_ACTIONS);
        turnsRef.current = 1;
        setTurns(1);
        setSelected(null);
        setWinner(null);
        setFlashIndex(null);
        setConfetti([]);
        setMoveOverlay(null);
        setIsAnimatingMove(false);
        completedOverlayIdRef.current = null;
        setIsPaused(false);
        setCpuThinking(false);

        const rolled = rollFairInitialState(snapshotTarget);
        const q = makeNextQueue(rolled.next0, rolled.next1, rolled.next2, 80);
        setBoard(rolled.board);
        setNextQueue(q);
        setNextIndex(0);
        setNextNumber(q[0]!);
        setActionDeadlineMs(Date.now() + 30_000);
        setScreen("play");
      })();
    }, 15_000);

    // --- Supabase キュー方式 ---
    // Simultaneous start を吸収するため、waiting(host) を作った後も一定間隔で
    // 「他の waiting を見つけて guest に切り替える」ことを続けます。
    let hostQueueId: number | null = null;
    let hostJoined = false;

    while (matchingRunIdRef.current === runId && !randomMatchResolvedRef.current) {
      const { data: waiting } = await supabase
        .from("public_matches")
        .select("id,room_id,status")
        .eq("status", "waiting")
        .limit(1)
        .maybeSingle<PublicMatchRow>();

      if (matchingRunIdRef.current !== runId) return;
      if (randomMatchResolvedRef.current) return;

      // まずは待機中ルームがあれば参加（自分が作った waiting は除外）
      if (waiting && waiting.id !== hostQueueId) {
        const { data: claimed } = await supabase
          .from("public_matches")
          .update({ status: "playing" })
          .eq("id", waiting.id)
          .eq("status", "waiting")
          .select("id,room_id,status")
          .maybeSingle<PublicMatchRow>();

        if (matchingRunIdRef.current !== runId) return;
        if (claimed && claimed.status === "playing") {
          // 自分の waiting(host) を破棄して、guest として参加する
          if (hostQueueId !== null && hostQueueId !== claimed.id) {
            try {
              await supabase.from("public_matches").delete().eq("id", hostQueueId);
            } catch {
              // best-effort
            }
          }

          await leaveOnlineRoom();

          setOnlineBotFallback(false);
          setCpuFallbackMessage(null);
          setOnlineOpponentName("");
          setMenuOnlineRole("guest");
          setMenuRoomId(claimed.room_id);
          setMatchId(claimed.id);
          setOnlineWaitingRoomId(claimed.room_id);
          setScreen("onlineWaiting");

          await joinOnlineRoom(claimed.room_id, "guest");
          return;
        }
      }

      // waiting が無い（または自分の待機）なら、まだ host になっていない場合は作る
      if (!hostJoined) {
        const roomId = genRoomId();
        const { data: created } = await supabase
          .from("public_matches")
          .insert({ room_id: roomId, status: "waiting" })
          .select("id,room_id,status")
          .maybeSingle<PublicMatchRow>();

        if (matchingRunIdRef.current !== runId) return;
        if (!created) {
          // 作成に失敗したら次ループへ（タイマー側がBOTへフォールバックする）
          await new Promise((r) => setTimeout(r, 240));
          continue;
        }

        hostQueueId = created.id;
        hostJoined = true;
        setMenuOnlineRole("host");
        setMenuRoomId(created.room_id);
        setMatchId(created.id);
        setOnlineWaitingRoomId(created.room_id);
        setScreen("onlineWaiting");

        // ホストはPresenceで「2人揃った瞬間」に初期盤面を broadcast して開始する
        await joinOnlineRoom(created.room_id, "host", {
          onPresenceSync: (ch) => {
            if (onlineStartOnceRef.current) return;

            const state = ch.presenceState() as Record<string, Array<{ player?: Player }>>;
            const players = new Set<number>();
            for (const entries of Object.values(state)) {
              for (const e of entries ?? []) {
                if (typeof e.player === "number") players.add(e.player);
              }
            }
            if (!players.has(1) || !players.has(2)) return;

            onlineStartOnceRef.current = true;
            randomMatchResolvedRef.current = true;
            if (randomFallbackTimeoutRef.current) {
              window.clearTimeout(randomFallbackTimeoutRef.current);
              randomFallbackTimeoutRef.current = null;
              setCpuFallbackMessage(null);
            }

            const appliedTarget = snapshotTarget;
            const rolled = rollFairInitialState(appliedTarget);
            const q = makeNextQueue(rolled.next0, rolled.next1, rolled.next2, 80);

            setTarget(appliedTarget);
            setMode("online");
            setCpuDifficulty("easy");
            setStartingPlayer(1);
            setCurrentPlayer(1);
            setMovesLeft(TURN_ACTIONS);
            turnsRef.current = 1;
            setTurns(1);
            setSelected(null);
            setWinner(null);
            setFlashIndex(null);
            setConfetti([]);
            setMoveOverlay(null);
            setIsAnimatingMove(false);
            completedOverlayIdRef.current = null;
            setIsPaused(false);
            setBoard(rolled.board);
            setNextQueue(q);
            setNextIndex(0);
            setNextNumber(q[0]!);

            const deadline = Date.now() + 30_000;
            setActionDeadlineMs(deadline);
            setScreen("play");

            void broadcastOnlineState({
              target: appliedTarget,
              board: rolled.board,
              nextNumber: q[0]!,
              nextQueue: q,
              nextIndex: 0,
              currentPlayer: 1,
              movesLeft: TURN_ACTIONS,
              turns: 1,
              winner: null,
              startingPlayer: 1,
              actionDeadlineMs: deadline,
            });
          },
        });
      }

      // 少し待って再度キューを取りに行う
      await new Promise((r) => setTimeout(r, 220));
    }
  }

  async function joinOnlineRoom(
    roomId: string,
    role: OnlineRole,
    opts?: { onPresenceSync?: (channel: RealtimeChannel) => void },
  ) {
    await leaveOnlineRoom();
    const clientId = getClientId();
    onlineClientIdRef.current = clientId;
    const player: Player = role === "host" ? 1 : 2;
    const myPlayer = player;
    const otherPlayer: Player = myPlayer === 1 ? 2 : 1;

    const channel = supabase.channel(`plus-battle-room-${roomId}`, {
      config: { broadcast: { ack: true }, presence: { key: clientId } },
    });

    channel.on("broadcast", { event: "state" }, (payload) => {
      const data = payload.payload as unknown as OnlineBroadcastState;
      if (!data || data.clientId === clientId) return;

      // ターン壁：自分のターン開始直後に遅延して届いた opponent 側 broadcast を無視して、
      // movesLeft やタイマーの「残像ゴースト」を防ぐ
      if (modeRef.current === "online") {
        if (Date.now() < turnWallUntilRef.current && data.currentPlayer !== currentPlayerRef.current) {
          return;
        }
      }

      // apply authoritative state
      const prev = boardRef.current;
      setTarget(data.target);
      setMode("online");
      setCpuDifficulty("easy");
      setStartingPlayer(data.startingPlayer);
      setCurrentPlayer(data.currentPlayer);
      setMovesLeft(data.movesLeft);
      setTurns(typeof data.turns === "number" ? data.turns : 1);
      // winner 確定時は即 setWinner せず、win() の pendingWinner を経由させて
      // 25ゴール演出のディレイと「二重処理の停止」を揃えます。
      if (data.winner !== null) {
        const delayForGoal = data.winReason === "goal" && targetRef.current === 25 ? 1500 + Math.floor(Math.random() * 501) : 500;
        win(data.winner, delayForGoal);
      } else {
        setWinner(null);
      }
      if ("actionDeadlineMs" in data) setActionDeadlineMs(typeof data.actionDeadlineMs === "number" ? data.actionDeadlineMs : null);
      setFlashIndex(null);
      setSelected(null);
      setIsAnimatingMove(false);
      setMoveOverlay(null);
      completedOverlayIdRef.current = null;

      setBoard(data.board);
      bumpForChanges(prev, data.board);
      setNextQueue(Array.isArray(data.nextQueue) ? data.nextQueue : []);
      setNextIndex(typeof data.nextIndex === "number" ? data.nextIndex : 0);
      setNextNumber(typeof data.nextNumber === "number" ? data.nextNumber : randInt(1, 9));
      setOnline((o) => (o ? { ...o, ready: true } : o));
      setScreen((s) => (s === "onlineWaiting" ? "play" : s));
      if (randomFallbackTimeoutRef.current) {
        // Random matchの開始が確定したので救済タイマーを止める
        window.clearTimeout(randomFallbackTimeoutRef.current);
        randomFallbackTimeoutRef.current = null;
        setCpuFallbackMessage(null);
        randomMatchResolvedRef.current = true;
      }
    });

    channel.on("presence", { event: "sync" }, () => {
      // Presenceから相手プレイヤー名を拾う（ホスト/ゲスト共通）
      const state = channel.presenceState() as Record<string, Array<{ player?: Player; name?: string; userId?: string }>>;
      let opponent = "";
      let opponentUserId = "";
      for (const entries of Object.values(state)) {
        for (const e of entries ?? []) {
          if (e?.player === otherPlayer) {
            if (typeof e?.name === "string" && e.name.trim()) opponent = e.name.trim();
            if (typeof e?.userId === "string" && e.userId.trim()) opponentUserId = e.userId.trim();
            break;
          }
        }
        if (opponent) break;
      }
      if (opponent) setOnlineOpponentName(opponent);
      if (opponentUserId) setOnlineOpponentUserId(opponentUserId);

      opts?.onPresenceSync?.(channel);
    });

    // Set immediately so presence callback can broadcast before `subscribe()` resolves.
    onlineChannelRef.current = channel;

    await channel.subscribe(async (status) => {
      if (status === "SUBSCRIBED") {
        // `playerName` はローカル保存値。対戦相手に表示するため Presence に同梱する
        await channel.track({ role, player, name: playerName, userId: clientId });
        setOnline({ enabled: true, roomId, role, player, clientId, ready: role === "host" });
      }
    });
  }

  async function broadcastOnlineState(nextState: {
    target: number;
    board: number[];
    nextNumber: number;
    nextQueue: number[];
    nextIndex: number;
    currentPlayer: Player;
    movesLeft: number;
    turns: number;
    winner: Winner;
    startingPlayer: Player;
    actionDeadlineMs?: number | null;
    winReason?: "goal" | "surrender";
  }) {
    if (!onlineChannelRef.current) return;
    const clientId = onlineClientIdRef.current;
    if (!clientId) return;
    await onlineChannelRef.current.send({
      type: "broadcast",
      event: "state",
      payload: { ...nextState, clientId },
    });
  }

  function startGame() {
    playSe("susumu");
    setUnlockMessage(null);
    setCpuThinking(false);
    setOnlineBotFallback(false);
    setOnlineOpponentName("");
    setResultRateChange(null);
    setResultRateNonce((n) => n + 1);
    setBotDisplayedOpponentRate(1500);
    botDisplayGeneratedRef.current = false;
    setShowGodVictory(false);
    setPendingWinner(null);
    if (pendingWinnerTimeoutRef.current) window.clearTimeout(pendingWinnerTimeoutRef.current);
    pendingWinnerTimeoutRef.current = null;
    // apply menu settings
    const appliedMode = menuMode;
    const appliedTarget = menuTarget;
    const appliedDifficulty = menuDifficulty;
    const first: Player =
      menuFirstTurn === "random" ? (Math.random() < 0.5 ? 1 : 2) : menuFirstTurn === "p1" ? 1 : 2;
    const appliedLimit = choiceToMs(menuTimeLimit);

    if (appliedMode === "online") {
      const roomId = (menuRoomId || "").trim();
      if (!roomId) return;
      setTimeLimitMs(appliedLimit);
      setMatchType("room");
      hasFetchedRatesForMatchRef.current = false;
      hasPersistedMatchRef.current = false;
      setRateLoading(false);
      setPlayerRate(1500);
      setOpponentRate(1500);
      setOnlineWaitingRoomId(roomId);
      onlineStartOnceRef.current = false;
      setScreen("onlineWaiting");

      void joinOnlineRoom(roomId, menuOnlineRole, {
        onPresenceSync: (ch) => {
          if (menuOnlineRole !== "host") return; // only host decides when to start
          if (onlineStartOnceRef.current) return;

          // Detect both players (1 and 2) in presence.
          const state = ch.presenceState() as Record<string, Array<{ player?: Player }>>;
          const players = new Set<number>();
          for (const entries of Object.values(state)) {
            for (const e of entries ?? []) {
              if (typeof e.player === "number") players.add(e.player);
            }
          }
          if (!players.has(1) || !players.has(2)) return;

          onlineStartOnceRef.current = true;

          const rolled = rollFairInitialState(appliedTarget);
          const q = makeNextQueue(rolled.next0, rolled.next1, rolled.next2, 80);
          setTarget(appliedTarget);
          setMode("online");
          setCpuDifficulty("easy");
          setStartingPlayer(1);
          setCurrentPlayer(1);
          setMovesLeft(TURN_ACTIONS);
          turnsRef.current = 1;
          setTurns(1);
          setSelected(null);
          setWinner(null);
          setFlashIndex(null);
          setConfetti([]);
          setMoveOverlay(null);
          setIsAnimatingMove(false);
          completedOverlayIdRef.current = null;
          setIsPaused(false);
          setBoard(rolled.board);
          setNextQueue(q);
          setNextIndex(0);
          setNextNumber(q[0]!);

          const deadline = appliedLimit === null ? null : Date.now() + appliedLimit;
          setActionDeadlineMs(deadline);
          // Move both players to play state.
          setScreen("play");

          void broadcastOnlineState({
            target: appliedTarget,
            board: rolled.board,
            nextNumber: q[0]!,
            nextQueue: q,
            nextIndex: 0,
            currentPlayer: 1,
            movesLeft: TURN_ACTIONS,
            turns: 1,
            winner: null,
            startingPlayer: 1,
            actionDeadlineMs: deadline,
          });
        },
      });
      return;
    }

    setTimeLimitMs(appliedLimit);
    setTarget(appliedTarget);
    setMode(appliedMode);
    setCpuDifficulty(appliedDifficulty);
    setMatchType(null);
    hasFetchedRatesForMatchRef.current = false;
    hasPersistedMatchRef.current = false;
    setRateLoading(false);
    setPlayerRate(1500);
    setOpponentRate(1500);
    setStartingPlayer(first);
    setCurrentPlayer(first);
    setMovesLeft(TURN_ACTIONS);
    turnsRef.current = 1;
    setTurns(1);
    const rolled = rollFairInitialState(appliedTarget);
    const q = makeNextQueue(rolled.next0, rolled.next1, rolled.next2, 80);
    setBoard(rolled.board);
    setNextQueue(q);
    setNextIndex(0);
    setNextNumber(q[0]!);
    setSelected(null);
    setWinner(null);
    setFlashIndex(null);
    setConfetti([]);
    setMoveOverlay(null);
    setIsAnimatingMove(false);
    completedOverlayIdRef.current = null;
    setIsPaused(false);
    setScreen("play");

    // start action timer for local/cpu
    setActionDeadlineMs(appliedLimit === null ? null : Date.now() + appliedLimit);
  }

  function backToMenu() {
    if (flashTimeoutRef.current) window.clearTimeout(flashTimeoutRef.current);
    if (cpuTimeoutRef.current) window.clearTimeout(cpuTimeoutRef.current);
    if (randomFallbackTimeoutRef.current) {
      window.clearTimeout(randomFallbackTimeoutRef.current);
      randomFallbackTimeoutRef.current = null;
    }
    setCpuFallbackMessage(null);
    playSe("modoru");
    setIsPaused(false);
    setUnlockMessage(null);
    setShowGodVictory(false);
    setPendingWinner(null);
    if (pendingWinnerTimeoutRef.current) window.clearTimeout(pendingWinnerTimeoutRef.current);
    pendingWinnerTimeoutRef.current = null;
    setWinner(null);
    setMoveOverlay(null);
    setIsAnimatingMove(false);
    completedOverlayIdRef.current = null;
    void cleanupMatchRecord();
    void leaveMatchChannel();
    void leaveOnlineRoom();
    setOnlineOpponentName("");
    setOnlineOpponentUserId("");
    setOnlineBotFallback(false);
    setMatchType(null);
    setRateLoading(false);
    hasFetchedMyRateForMatchRef.current = false;
    setPlayerRate(1500);
    setOpponentRate(1500);
    setBotDisplayedOpponentRate(1500);
    botDisplayGeneratedRef.current = false;
    setResultRateChange(null);
    setResultRateNonce((n) => n + 1);
    setScreen("menu");
  }

  function reset(nextMode: GameMode = modeRef.current) {
    if (flashTimeoutRef.current) window.clearTimeout(flashTimeoutRef.current);
    if (cpuTimeoutRef.current) window.clearTimeout(cpuTimeoutRef.current);
    setUnlockMessage(null);
    setShowGodVictory(false);
    setResultModalReady(true);
    setPendingWinner(null);
    if (pendingWinnerTimeoutRef.current) window.clearTimeout(pendingWinnerTimeoutRef.current);
    pendingWinnerTimeoutRef.current = null;
    const rolled = rollFairInitialState(targetRef.current);
    setBoard(rolled.board);
    const q = makeNextQueue(rolled.next0, rolled.next1, rolled.next2, 80);
    setNextQueue(q);
    setNextIndex(0);
    setNextNumber(q[0]!);
    setCurrentPlayer(startingPlayer);
    setMovesLeft(TURN_ACTIONS);
    setMode(nextMode);
    setSelected(null);
    setWinner(null);
    setFlashIndex(null);
    setConfetti([]);
    setMoveOverlay(null);
    setIsAnimatingMove(false);
    completedOverlayIdRef.current = null;
    setBumpIds(Array.from({ length: TILE_COUNT }, () => 0));
    {
      const limit = timeLimitMsRef.current;
      setActionDeadlineMs(limit === null ? null : Date.now() + limit);
    }
    cpuPlannedLineRef.current = null;

    if (nextMode === "online" && online) {
      const limit = timeLimitMsRef.current;
      const deadline = limit === null ? null : Date.now() + limit;
      setActionDeadlineMs(deadline);
      void broadcastOnlineState({
        target: targetRef.current,
        board: rolled.board,
        nextNumber: q[0]!,
        nextQueue: q,
        nextIndex: 0,
        currentPlayer: startingPlayer,
        movesLeft: TURN_ACTIONS,
        turns: turnsRef.current,
        winner: null,
        startingPlayer,
        actionDeadlineMs: deadline,
      });
    }
  }

  function triggerFlash(idx: number) {
    if (flashTimeoutRef.current) window.clearTimeout(flashTimeoutRef.current);
    setFlashIndex(idx);
    flashTimeoutRef.current = window.setTimeout(() => setFlashIndex(null), 420);
  }

  function win(p: Player, delayMs: number = 500) {
    // すでに勝敗が確定/演出中の場合は二重処理を防ぐ
    if (winnerRef.current || pendingWinnerRef.current) return;
    // まず結果モーダルは非表示にして、最新レート再取得後に表示する
    setResultModalReady(false);
    if (pendingWinnerTimeoutRef.current) window.clearTimeout(pendingWinnerTimeoutRef.current);
    // pendingWinner は「勝利演出中の入力ロック」にも使うため、ref と state を即時同期する
    pendingWinnerRef.current = p;
    setPendingWinner(p);
    setSelected(null);
    setConfetti(makeConfetti(90));
    const praises = ["ナイスプラス！", "完璧な計算！", "天才か？", "読みが鋭い！", "神業…！", "しびれる一手！"];
    setVictoryPraise(praises[Math.floor(Math.random() * praises.length)]!);
    pendingWinnerTimeoutRef.current = window.setTimeout(() => {
      void (async () => {
        // iPhone/Safari 向け:
        // 勝敗演出ディレイ中に DB の最新レートを直接取得し、結果表示直前の値を強制同期する
        try {
          if (matchTypeRef.current === "random") {
            const myUserId = getClientId();
            const oppUserId = onlineOpponentUserId;

            const before = resultRateChange;
            const [{ data: myLatest }, { data: oppLatest }] = await Promise.all([
              supabase
                .from("player_ratings")
                .select("rating")
                .eq("user_id", myUserId)
                .maybeSingle<PlayerRatingRow>(),
              oppUserId
                ? supabase
                    .from("player_ratings")
                    .select("rating")
                    .eq("user_id", oppUserId)
                    .maybeSingle<PlayerRatingRow>()
                : Promise.resolve({ data: null }),
            ]);

            const myAfter = myLatest?.rating && Number.isFinite(myLatest.rating) ? Math.round(myLatest.rating) : playerRateRef.current;
            const oppAfter =
              oppLatest && oppLatest.rating && Number.isFinite(oppLatest.rating)
                ? Math.round(oppLatest.rating)
                : opponentRateRef.current;

            setPlayerRate(myAfter);
            if (oppUserId) setOpponentRate(oppAfter);

            if (before) {
              setResultRateChange({
                yourBefore: before.yourBefore,
                yourAfter: myAfter,
                opponentBefore: before.opponentBefore,
                opponentAfter: oppAfter,
                yourDelta: myAfter - before.yourBefore,
                opponentDelta: oppAfter - before.opponentBefore,
              });
            }
          }
        } catch {
          // ignore
        } finally {
          setWinner(p);
          setPendingWinner(null);
          pendingWinnerRef.current = null;
          pendingWinnerTimeoutRef.current = null;
        }
      })();
    }, delayMs);
  }

  function surrenderOnline() {
    // 降参: 自分が負ける => 相手が勝つ
    if (winnerRef.current) return;
    const me = currentPlayerRef.current;
    const opponent: Player = me === 1 ? 2 : 1;

    // 状態を即座に勝利演出へ寄せる（pendingWinner を使って入力も止める）
    win(opponent);

    // 可能なら相手へも勝敗確定をブロードキャストして同期する
    if (modeRef.current === "online" && onlineChannelRef.current) {
      void broadcastOnlineState({
        target: targetRef.current,
        board: boardRef.current,
        nextNumber: nextNumberRef.current,
        nextQueue: nextQueueRef.current,
        nextIndex: nextIndexRef.current,
        currentPlayer: opponent,
        movesLeft: 0,
        turns: turnsRef.current,
        winner: opponent,
        startingPlayer,
        actionDeadlineMs: null,
        winReason: "surrender",
      });
    }
  }

  useEffect(() => {
    if (!winner) return;
    if (modeRef.current !== "cpu") return;
    if (winner !== 1) return;

    const d = cpuDifficultyRef.current;
    if (d === "god") {
      setShowGodVictory(true);
      // gold/silver burst
      try {
        confettiBurst({
          particleCount: 220,
          spread: 85,
          origin: { y: 0.65 },
          colors: ["#D4AF37", "#C0C0C0", "#FFF1A8", "#E6E6E6"],
        });
        window.setTimeout(() => {
          confettiBurst({
            particleCount: 160,
            spread: 75,
            origin: { y: 0.25 },
            colors: ["#D4AF37", "#C0C0C0", "#FFF1A8", "#E6E6E6"],
          });
        }, 220);
      } catch {
        // ignore
      }
    }
    if (d === "normal") {
      setUnlockedDifficulties((u) => {
        if (u.includes("hard")) return u;
        setUnlockMessage("Hardモードが解放されました！");
        return [...u, "hard"];
      });
    } else if (d === "hard") {
      setUnlockedDifficulties((u) => {
        if (u.includes("god")) return u;
        setUnlockMessage("Godモードが解放されました！");
        return [...u, "god"];
      });
    }
  }, [winner]);

  useEffect(() => {
    if (!winner) return;
    // 相手（CPU側）が勝った場合は make.mp3
    if (modeRef.current === "cpu" && winner === 2) {
      playSe("make");
      return;
    }
    const isGod = modeRef.current === "cpu" && cpuDifficultyRef.current === "god" && winner === 1;
    playSe(isGod ? "godwin" : "win");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [winner]);

  /**
   * 勝敗が確定したタイミングで、対戦履歴を保存し、条件に応じて Elo を更新します。
   *
   * 注意:
   * - オンライン対戦はホスト側だけが INSERT/UPDATE を行うようにしています（重複保存防止）。
   * - Elo は `match_type === "random"` のときだけ更新します。
   * - CPU 対戦（ローカルCPU含む）も stats 用に match_history を保存します（Elo更新なし）。
   */
  useEffect(() => {
    if (!winner) return;
    if (hasPersistedMatchRef.current) return;
    if (screen !== "play") return;

    // 同じ勝利イベントで二重保存しない
    hasPersistedMatchRef.current = true;

    void (async () => {
      try {
        const myUserId = getClientId();
      const turnsUsed = turnsRef.current;
      const turnsToGoal25 = turnsToGoal25Ref.current;

      const modeNow = modeRef.current;

      // オンライン対戦では DB の Elo 更新はホストだけが行います。
      // ただし、ゲスト側も「リザルトでレート変動」を表示できるよう、
      // 結果時に DB の現在レートを取り直して差分を作ります（保存/更新はしない）。
      if (modeNow === "online" && online && online.role !== "host") {
        const mt = matchTypeRef.current;
        if (mt === "random" && onlineOpponentUserId) {
          const beforeYour = playerRateRef.current;
          const beforeOpp = opponentRateRef.current;
          // ホストの UPDATE が完了する前にゲストが取得してしまうのを避けるため少し待つ
          await new Promise((r) => setTimeout(r, 250));

          // iPhone 対応：結果表示直前に最新レートを直接 SELECT して上書きする
          const [
            { data: yourRow },
            { data: oppRow },
          ] = await Promise.all([
            supabase
              .from("player_ratings")
              .select("rating")
              .eq("user_id", myUserId)
              .maybeSingle<PlayerRatingRow>(),
            supabase
              .from("player_ratings")
              .select("rating")
              .eq("user_id", onlineOpponentUserId)
              .maybeSingle<PlayerRatingRow>(),
          ]);

          const afterYour = yourRow?.rating && Number.isFinite(yourRow.rating) ? Math.round(yourRow.rating) : 1500;
          const afterOpp = oppRow?.rating && Number.isFinite(oppRow.rating) ? Math.round(oppRow.rating) : 1500;

          setPlayerRate(afterYour);
          setOpponentRate(afterOpp);
          setResultRateChange({
            yourBefore: beforeYour,
            yourAfter: afterYour,
            opponentBefore: beforeOpp,
            opponentAfter: afterOpp,
            yourDelta: afterYour - beforeYour,
            opponentDelta: afterOpp - beforeOpp,
          });
          setResultRateNonce((n) => n + 1);
        }
        return;
      }

      // match_type を DB 用に確定します。
      // - online: matchTypeRef は "random" / "room" のいずれか
      // - cpu: matchTypeRef が "random" の場合は疑似オンライン（Elo対象）
      //        それ以外は cpu_easy/normal/hard/god
      let dbMatchType: MatchHistoryInsert["match_type"];
      let player1Id = myUserId;
      let player2Id = "";
      let winnerId = "";

      // Elo更新に使う「相手 userId」（random疑似オンラインのときに必要）
      let opponentUserIdForElo = "";

      try {
        if (modeNow === "online") {
          // online はホストだけが DB へ書き込み
          if (!online || online.role !== "host") return;

          const mt = matchTypeRef.current;
          if (mt !== "random" && mt !== "room") return;
          dbMatchType = mt;

          // 降参直後など、Presence 同期のタイミングで `onlineOpponentUserId` が未確定のまま
          // 勝敗確定になっても Elo/履歴保存が止まらないよう、Presence state から再取得します。
          let opponentIdForElo = onlineOpponentUserId;
          if (!opponentIdForElo) {
            const ch = onlineChannelRef.current;
            const presenceState = ch?.presenceState() as
              | Record<string, Array<{ player?: Player; userId?: string; name?: string }>>
              | undefined;
            const otherPlayer: Player = online.player === 1 ? 2 : 1;
            for (const entries of Object.values(presenceState ?? {})) {
              for (const e of entries ?? []) {
                if (e?.player === otherPlayer && typeof e?.userId === "string" && e.userId.trim()) {
                  opponentIdForElo = e.userId.trim();
                  break;
                }
              }
              if (opponentIdForElo) break;
            }
          }

          if (!opponentIdForElo) return;
          opponentUserIdForElo = opponentIdForElo;

          const localIsPlayer1 = online.player === 1;
          player1Id = localIsPlayer1 ? myUserId : opponentIdForElo;
          player2Id = localIsPlayer1 ? opponentIdForElo : myUserId;
          winnerId = winner === 1 ? player1Id : player2Id;
        } else if (modeNow === "cpu") {
          // CPU はローカルのため Elo なし。ただし random 疑似オンラインだけ例外で Elo 更新する。
          const mt = matchTypeRef.current;

          if (mt === "random") {
            if (!onlineOpponentUserId) return;
            dbMatchType = "random";
            opponentUserIdForElo = onlineOpponentUserId;
            player1Id = myUserId; // CPUゲームでは player1 が人間側
            player2Id = onlineOpponentUserId; // player2 が BOT 側
            winnerId = winner === 1 ? player1Id : player2Id;
          } else {
            // 通常CPU（Easy/Normal/Hard/God）
            const d = cpuDifficultyRef.current;
            dbMatchType =
              d === "easy" ? "cpu_easy" : d === "normal" ? "cpu_normal" : d === "hard" ? "cpu_hard" : "cpu_god";
            // 人間側 = player1、CPU側 = player2
            player1Id = myUserId;
            player2Id = `cpu_bot_${d}`; // stats集計用の疑似ユーザー
            winnerId = winner === 1 ? player1Id : player2Id;
          }
        } else {
          // local 対戦は stats の対象外（必要なら追加してください）
          return;
        }

        // 1) 対戦履歴は必ず保存（stats 可視化のため）
        try {
          await insertMatchHistory({
            player1_id: player1Id,
            player2_id: player2Id,
            winner_id: winnerId,
            turns: turnsUsed,
            match_type: dbMatchType,
            // DBに列が無い可能性があるため、未達ならキー自体を送らない（undefined）
            turns_to_goal25: turnsToGoal25 ?? undefined,
            created_at: new Date().toISOString(),
          });
        } catch (err) {
          // DB列追加漏れなどで保存できなくてもゲームは止めないが、原因特定のためログは出す
          console.error("[match_history insert (inner) failed]", err);
        }

        // 2) Elo 更新は match_type が random のときのみ
        if (dbMatchType !== "random") return;

        const rating1 = await getOrCreatePlayerRating(player1Id);
        // BOT（疑似オンライン）だけ、対戦開始時に生成した偽装レートを Elo 基準にする
        const rating2 =
          modeNow === "cpu" && onlineBotFallbackRef.current
            ? botFakeRateRef.current
            : await getOrCreatePlayerRating(player2Id);

        const winnerSide: "A" | "B" = winner === 1 ? "A" : "B";
        const { newRatingA, newRatingB } = calcEloAfterMatch({
          ratingA: rating1,
          ratingB: rating2,
          winner: winnerSide,
        });

        // リザルト画面用：変動前→変動後（あなた/相手両方）を保持
        const yourBefore = myUserId === player1Id ? rating1 : rating2;
        const yourAfter = myUserId === player1Id ? newRatingA : newRatingB;
        const opponentBefore = myUserId === player1Id ? rating2 : rating1;
        const opponentAfter = myUserId === player1Id ? newRatingB : newRatingA;
        setResultRateChange({
          yourBefore,
          yourAfter,
          opponentBefore,
          opponentAfter,
          yourDelta: yourAfter - yourBefore,
          opponentDelta: opponentAfter - opponentBefore,
        });
        setResultRateNonce((n) => n + 1);

        await Promise.all([upsertPlayerRating(player1Id, newRatingA), upsertPlayerRating(player2Id, newRatingB)]);

        // 自分側のレート状態も更新（random時だけ UI に反映されているため）
        if (myUserId === player1Id) setPlayerRate(newRatingA);
        if (myUserId === player2Id) setPlayerRate(newRatingB);
        if (opponentUserIdForElo === player1Id) setOpponentRate(newRatingA);
        if (opponentUserIdForElo === player2Id) setOpponentRate(newRatingB);

        // iPhone 対応：結果表示直前に最新レートを直接 SELECT して上書きする
        // （Elo 計算→UPDATE→状態反映の非同期で UI が古い値のままになるのを防ぐ）
        try {
          if (dbMatchType === "random") {
            const yourUserId = myUserId === player1Id ? player1Id : player2Id;
            const oppUserId = yourUserId === player1Id ? player2Id : player1Id;

            const [{ data: yourLatestRow }, { data: oppLatestRow }] = await Promise.all([
              supabase
                .from("player_ratings")
                .select("rating")
                .eq("user_id", yourUserId)
                .maybeSingle<PlayerRatingRow>(),
              supabase
                .from("player_ratings")
                .select("rating")
                .eq("user_id", oppUserId)
                .maybeSingle<PlayerRatingRow>(),
            ]);

            const yourAfterLatest =
              yourLatestRow?.rating && Number.isFinite(yourLatestRow.rating) ? Math.round(yourLatestRow.rating) : yourAfter;
            const opponentAfterLatest =
              oppLatestRow?.rating && Number.isFinite(oppLatestRow.rating) ? Math.round(oppLatestRow.rating) : opponentAfter;

            setPlayerRate(yourAfterLatest);
            setOpponentRate(opponentAfterLatest);
            setResultRateChange({
              yourBefore,
              yourAfter: yourAfterLatest,
              opponentBefore,
              opponentAfter: opponentAfterLatest,
              yourDelta: yourAfterLatest - yourBefore,
              opponentDelta: opponentAfterLatest - opponentBefore,
            });
          }
        } catch {
          // ignore (再取得失敗時は Elo 計算済みの値をそのまま使う)
        }
      } catch (err) {
        console.error("[match persistence failed]", err);
        // DBエラーでもゲーム進行を止めない
      }
      } finally {
        // iPhone 対応：結果モーダル表示の準備が整ったらゲートを開く
        setResultModalReady(true);
      }
    })();
  }, [winner, screen, onlineOpponentUserId, online]);

  function bumpForChanges(prev: number[], next: number[]) {
    setBumpIds((ids) => ids.map((id, i) => (prev[i] === next[i] ? id : id + 1)));
  }

  function endTurnOrContinue(didWin: boolean) {
    if (didWin) return;
    const after = Math.max(0, movesLeftRef.current - 1);
    if (after === 0) {
      // 3アクション（= 1ターン）消化。次のプレイヤーへターンが進むので turns を +1。
      turnsRef.current += 1;
      setTurns(turnsRef.current);
      setMovesLeft(TURN_ACTIONS);
      setCurrentPlayer((p) => (p === 1 ? 2 : 1));
    } else {
      setMovesLeft(after);
    }
  }

  function endTurnNow() {
    if (winnerRef.current) return;
    if (movesLeftRef.current === TURN_ACTIONS) return; // prevent accidental skip before doing anything
    cpuPlannedLineRef.current = null;

    // 手動でターンを終了するので turns を +1
    turnsRef.current += 1;
    setTurns(turnsRef.current);
    setMovesLeft(TURN_ACTIONS);
    setCurrentPlayer((p) => (p === 1 ? 2 : 1));

    const limit = timeLimitMsRef.current;
    const newDeadline = limit === null ? null : Date.now() + limit;
    setActionDeadlineMs(newDeadline);

    if (modeRef.current === "online" && online && online.player === currentPlayerRef.current) {
      const nextPlayer: Player = currentPlayerRef.current === 1 ? 2 : 1;
      void broadcastOnlineState({
        target: targetRef.current,
        board: boardRef.current,
        nextNumber: nextNumberRef.current,
        nextQueue: nextQueueRef.current,
        nextIndex: nextIndexRef.current,
        currentPlayer: nextPlayer,
        movesLeft: TURN_ACTIONS,
        turns: turnsRef.current,
        winner: null,
        startingPlayer,
        actionDeadlineMs: newDeadline,
      });
    }
  }

  function consumeNextAfterUse() {
    const q = nextQueueRef.current.length ? [...nextQueueRef.current] : Array.from({ length: 80 }, () => randInt(1, 9));
    let idx = nextIndexRef.current;
    const used = q[idx] ?? randInt(1, 9);
    idx += 1;
    if (idx >= q.length) {
      while (q.length < idx + 80) q.push(randInt(1, 9));
    }
    const nextNum = q[idx] ?? randInt(1, 9);
    setNextQueue(q);
    setNextIndex(idx);
    setNextNumber(nextNum);
    return { used, q, idx, nextNum };
  }

  function applyMove(from: number, to: number) {
    const prev = boardRef.current;
    const next = [...prev];
    const sum = prev[to] + prev[from];
    const t = targetRef.current;
    const computedToValue = sum === t ? t : sum > t ? sum % t : sum;
    next[to] = computedToValue;
    const { used, q, idx, nextNum } = consumeNextAfterUse();
    next[from] = used;

    const didWin = sum === t;
    const shouldFlash = sum > t;

    setBoard(next);
    bumpForChanges(prev, next);
    if (shouldFlash) triggerFlash(to);
    if (didWin) {
      // 25（= GOAL）完成時は、最後の盤面を見せるため少しディレイして勝利確定へ寄せます。
      // これにより、pendingWinner の間は入力/自動手が止まり二重処理も防げます。
      const delayForWin = t === 25 ? 1500 + Math.floor(Math.random() * 501) : 500;
      if (t === 25) triggerFlash(to); // 25になったマスを軽くフィードバック
      win(currentPlayerRef.current, delayForWin);
    }
    endTurnOrContinue(didWin);
    if (movesLeftRef.current - 1 <= 0) cpuPlannedLineRef.current = null;

    // タイマーは「ターン開始時」にのみ規定秒数を上書きする。
    // ここで毎手リセットすると合計時間が伸びて表示が異常（例: 38秒など）になりやすい。
    const afterMovesLeft = Math.max(0, movesLeftRef.current - 1);
    const turnEnds = afterMovesLeft === 0;
    const limit = timeLimitMsRef.current;
    const nextTurnDeadline = limit === null ? null : Date.now() + limit;
    if (modeRef.current === "online") {
      if (didWin) {
        // 勝敗確定前でも入力は pendingWinner で止まるが、タイマー暴走を避けるため null に寄せる
        setActionDeadlineMs(null);
      } else if (turnEnds) {
        setActionDeadlineMs(nextTurnDeadline);
      }
    } else {
      // ローカル/CPU は従来通り、手のたびにタイマーをリセットする挙動を維持
      const newDeadline = limit === null ? null : Date.now() + limit;
      setActionDeadlineMs(newDeadline);
    }

    // Online sync (authoritative by active player)
    if (modeRef.current === "online" && online && online.player === currentPlayerRef.current) {
      const nextPlayer: Player = turnEnds ? (currentPlayerRef.current === 1 ? 2 : 1) : currentPlayerRef.current;
      const movesLeftNext = turnEnds ? TURN_ACTIONS : afterMovesLeft;
      // turns/movesLeft/actionDeadlineMs を「次のターン状態」に合わせて送る
      // （従来 movesLeft が 2 になっていたため、片側だけ「残り3回」/「残り2回」ズレが発生していました）
      void broadcastOnlineState({
        target: t,
        board: next,
        nextNumber: nextNum,
        nextQueue: q,
        nextIndex: idx,
        currentPlayer: didWin ? currentPlayerRef.current : nextPlayer,
        movesLeft: didWin ? 0 : movesLeftNext,
        turns: turnsRef.current,
        winner: didWin ? currentPlayerRef.current : null,
        startingPlayer,
        ...(didWin ? { winReason: "goal" } : {}),
        // タイマーはターン開始時だけ更新する（turnEnds のときだけ actionDeadlineMs を含める）
        ...(didWin ? { actionDeadlineMs: null as number | null } : turnEnds ? { actionDeadlineMs: nextTurnDeadline } : {}),
      });
    }
  }

  function centerInBoard(el: HTMLElement) {
    const boardEl = boardWrapRef.current;
    if (!boardEl) return null;
    const b = boardEl.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    return { x: r.left - b.left + r.width / 2, y: r.top - b.top + r.height / 2 };
  }

  function startMove(from: number, to: number) {
    const fromEl = tileRefs.current[from];
    const toEl = tileRefs.current[to];
    const fromCenter = fromEl ? centerInBoard(fromEl) : null;
    const toCenter = toEl ? centerInBoard(toEl) : null;

    isProcessingRef.current = true;
    setIsProcessing(true);
    if (prefersReducedMotion || !fromCenter || !toCenter) {
      playRandomYuugou();
      applyMove(from, to);
      window.setTimeout(() => {
        setIsProcessing(false);
        isProcessingRef.current = false;
      }, 0);
      return;
    }

    setIsAnimatingMove(true);
    completedOverlayIdRef.current = null;
    // Merge SE should happen at the moment the animation starts.
    playRandomYuugou();

    const fromValue = boardRef.current[from]!;
    const toValueBefore = boardRef.current[to]!;
    const sum = toValueBefore + fromValue;
    const t = targetRef.current;
    const toValueAfter = sum === t ? t : sum > t ? sum % t : sum;
    const fusionCenter = {
      x: (fromCenter.x + toCenter.x) / 2,
      y: (fromCenter.y + toCenter.y) / 2,
    };
    setMoveOverlay({
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      from,
      to,
      fromCenter,
      toCenter,
      fusionCenter,
      fromValue,
      toValueBefore,
      toValueAfter,
    });
  }

  function neighborIndex(idx: number, dir: "up" | "down" | "left" | "right") {
    const r = Math.floor(idx / BOARD_SIZE);
    const c = idx % BOARD_SIZE;
    if (dir === "up") return r > 0 ? idx - BOARD_SIZE : null;
    if (dir === "down") return r < BOARD_SIZE - 1 ? idx + BOARD_SIZE : null;
    if (dir === "left") return c > 0 ? idx - 1 : null;
    return c < BOARD_SIZE - 1 ? idx + 1 : null;
  }

  function handleTouchStart(idx: number, e: React.TouchEvent) {
    if (!canInteract) return;
    if (isProcessingRef.current || isAnimatingMove || moveOverlay) return;
    const t = e.touches[0];
    if (!t) return;
    touchStartRef.current = { idx, x: t.clientX, y: t.clientY };
  }

  function handleTouchEnd(idx: number, e: React.TouchEvent) {
    if (!canInteract) return;
    const start = touchStartRef.current;
    touchStartRef.current = null;
    if (!start || start.idx !== idx) return;

    const t = e.changedTouches[0];
    if (!t) return;
    const dx = t.clientX - start.x;
    const dy = t.clientY - start.y;

    const absX = Math.abs(dx);
    const absY = Math.abs(dy);
    const threshold = 26;
    if (absX < threshold && absY < threshold) return;

    const dir: "up" | "down" | "left" | "right" =
      absX >= absY ? (dx > 0 ? "right" : "left") : (dy > 0 ? "down" : "up");
    const to = neighborIndex(idx, dir);
    if (to === null) return;
    startMove(idx, to);
  }

  function listAllMoves(b: number[]): Array<{ from: number; to: number; sum: number; toValue: number }> {
    const moves: Array<{ from: number; to: number; sum: number; toValue: number }> = [];
    const t = targetRef.current;
    for (let from = 0; from < TILE_COUNT; from++) {
      for (let to = 0; to < TILE_COUNT; to++) {
        if (from === to) continue;
        if (!isAdjacent(from, to)) continue;
        const sum = b[to] + b[from];
        const toValue = sum === t ? t : sum > t ? sum % t : sum;
        moves.push({ from, to, sum, toValue });
      }
    }
    return moves;
  }

  // CPU AI planning is delegated to `engine/ai.ts`.

  function planCpuMove(): PlannedMove | null {
    const existing = cpuPlannedLineRef.current;
    if (existing && existing.length > 0) {
      return existing.shift() ?? null;
    }

    const plan = getCpuMovePlan({
      board: boardRef.current,
      target: targetRef.current,
      nextQueue: nextQueueRef.current,
      nextIndex: nextIndexRef.current,
      movesLeft: movesLeftRef.current,
      difficulty: cpuDifficultyRef.current,
      rng: Math.random,
    });

    if (!plan?.line?.length) return null;

    const queue = [...plan.line] as PlannedMove[];
    const first = queue.shift() ?? null;
    cpuPlannedLineRef.current = queue;
    return first;
  }

  function handleTileClick(idx: number) {
    if (!canInteract) return;
    if (isProcessingRef.current || isAnimatingMove || moveOverlay) return;

    if (selected === null) {
      setSelected(idx);
      return;
    }

    if (selected === idx) {
      setSelected(null);
      return;
    }

    if (!isAdjacent(selected, idx)) {
      setSelected(idx);
      return;
    }

    const from = selected;
    const to = idx;
    setSelected(null);
    startMove(from, to);
  }

  function finishMove() {
    if (!moveOverlay) return;
    if (completedOverlayIdRef.current === moveOverlay.id) return;
    completedOverlayIdRef.current = moveOverlay.id;
    const { from, to } = moveOverlay;

    setMoveOverlay(null);
    setIsAnimatingMove(false);
    applyMove(from, to);
    window.setTimeout(() => {
      setIsProcessing(false);
      isProcessingRef.current = false;
    }, 0);
  }

  useEffect(() => {
    return () => {
      if (flashTimeoutRef.current) window.clearTimeout(flashTimeoutRef.current);
    };
  }, []);

  useEffect(() => {
    if (!isCpuTurn) return;
    if (winnerRef.current) return;
    if (pendingWinnerRef.current) return; // 勝敗演出中は思考/自動操作を止める
    if (isAnimatingMove) return;
    if (movesLeftRef.current <= 0) return;

    if (cpuTimeoutRef.current) window.clearTimeout(cpuTimeoutRef.current);

    setCpuThinking(true);
    // Humanize（長い思考時間）は「ランダムマッチのBOT」だけに限定する
    const isRandomBot = onlineBotFallback && matchTypeRef.current === "random";
    const delayMs = isRandomBot ? 1500 + Math.floor(Math.random() * 2501) : 500;
    cpuTimeoutRef.current = window.setTimeout(() => {
      setCpuThinking(false);
      if (modeRef.current !== "cpu") return;
      if (winnerRef.current) return;
      if (currentPlayerRef.current !== 2) return;
      if (movesLeftRef.current <= 0) return;
      if (isAnimatingMove) return;

      const planned = planCpuMove();
      if (!planned) return;

      setSelected(null);
      startMove(planned.from, planned.to);
    }, delayMs);

    return () => {
      if (cpuTimeoutRef.current) window.clearTimeout(cpuTimeoutRef.current);
      cpuTimeoutRef.current = null;
      setCpuThinking(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isCpuTurn, isAnimatingMove, movesLeft, board, nextNumber, nextIndex, cpuDifficulty, onlineBotFallback]);

  useEffect(() => {
    if (mode !== "cpu" || currentPlayer !== 2) cpuPlannedLineRef.current = null;
  }, [currentPlayer, mode]);

  function randomLegalMove(): PlannedMove | null {
    const moves = listAllMoves(boardRef.current);
    if (moves.length === 0) return null;
    const m = moves[Math.floor(Math.random() * moves.length)]!;
    return { from: m.from, to: m.to };
  }

  useEffect(() => {
    // 勝敗演出待ち（pendingWinner）中は盤面が確定していても操作/自動手が走ると二重処理になるため停止する
    if (screen !== "play" || isPaused || winner || pendingWinnerRef.current) return;
    if (isAnimatingMove || moveOverlay) return;
    if (timeLeftMs === null) return;
    if (timeLeftMs > 0) return;
    if (mode === "cpu" && currentPlayer === 2) return;
    if (mode === "online" && (!online || online.player !== currentPlayer)) return;

    const planned = randomLegalMove();
    if (!planned) return;
    setSelected(null);
    startMove(planned.from, planned.to);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentPlayer, isAnimatingMove, isPaused, moveOverlay, nowMs, online, screen, timeLeftMs, winner, mode, pendingWinner]);

  return (
    <main className="h-[100dvh] flex flex-col max-h-screen overflow-hidden pb-[env(safe-area-inset-bottom)] text-zinc-900">
      {/* Gooey (slime/water merge) effect */}
      <svg width="0" height="0" aria-hidden="true" focusable="false" style={{ position: "absolute" }}>
        <defs>
          <filter id="gooey">
            <feGaussianBlur in="SourceGraphic" stdDeviation="7" result="blur" />
            <feColorMatrix
              in="blur"
              mode="matrix"
              values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 22 -11"
              result="gooey"
            />
            <feComposite in="SourceGraphic" in2="gooey" operator="atop" />
          </filter>
        </defs>
      </svg>
      {/* Cream polka dots (back layer) */}
      <div
        className="fixed inset-0 -z-20"
        style={{
          backgroundColor: "#FFF4DE",
          backgroundImage:
            "radial-gradient(circle at 12px 12px, rgba(160,110,70,.14) 2px, transparent 2.6px)," +
            "radial-gradient(circle at 8px 8px, rgba(255,155,205,.10) 1.6px, transparent 2.2px)",
          backgroundSize: "24px 24px, 20px 20px",
        }}
      />

      {/* Floating Background (between dots and panels) */}
      <div className="pointer-events-none fixed inset-0 -z-10 overflow-hidden">
        {[
          { left: "12%", top: "72%", size: 140, color: "rgba(255,140,190,.44)" },
          { left: "28%", top: "20%", size: 110, color: "rgba(255,210,120,.44)" },
          { left: "52%", top: "58%", size: 170, color: "rgba(140,255,205,.44)" },
          { left: "72%", top: "28%", size: 120, color: "rgba(150,200,255,.44)" },
          { left: "86%", top: "66%", size: 180, color: "rgba(255,170,120,.44)" },
          { left: "40%", top: "40%", size: 100, color: "rgba(210,160,255,.42)" },
          { left: "62%", top: "82%", size: 120, color: "rgba(120,255,240,.40)" },
          { left: "18%", top: "36%", size: 90, color: "rgba(255,210,235,.40)" },
          // extra accents around edges so they don't cover the main mode select card
          { left: "4%", top: "10%", size: 80, color: "rgba(255,190,210,.40)" },
          { left: "6%", top: "86%", size: 90, color: "rgba(180,225,255,.40)" },
          { left: "90%", top: "14%", size: 80, color: "rgba(210,255,210,.42)" },
          { left: "92%", top: "82%", size: 100, color: "rgba(255,210,170,.42)" },
        ].map((b, i) => (
          <motion.div
            key={i}
            className="absolute"
            style={{ left: b.left, top: b.top, width: b.size, height: b.size, opacity: 0.42 }}
            animate={{
              y: [0, -30, 0],
              rotate: [0, 180, 360],
            }}
            transition={{
              duration: 10 + (i % 4) * 3,
              repeat: Infinity,
              ease: "easeInOut",
              delay: i * 0.35,
            }}
          >
            <div
              className="h-full w-full rounded-[44px]"
              style={{
                background: `radial-gradient(circle at 30% 25%, rgba(255,255,255,.60), transparent 55%), ${b.color}`,
                boxShadow: "0 30px 90px rgba(120,70,40,.14)",
              }}
            />
          </motion.div>
        ))}
      </div>
      <div className="relative z-10 mx-auto flex h-full max-h-full w-full max-w-4xl flex-col items-center overflow-hidden px-3 py-2 pb-[env(safe-area-inset-bottom)] md:px-4 md:py-4">
        <AnimatePresence mode="wait">
        {screen === "title" ? (
          <motion.div
            key="title"
            className="w-full"
            initial={{ opacity: 0, y: 10, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -10, scale: 0.98 }}
            transition={{ type: "spring", stiffness: 520, damping: 42, mass: 0.9 }}
          >
            <div className="flex flex-col gap-4 rounded-[36px] border border-white/70 bg-gradient-to-b from-white/75 to-white/55 p-5 text-center shadow-[0_26px_90px_rgba(120,70,40,.18)] backdrop-blur md:gap-6 md:rounded-[40px] md:p-7">
              <div>
                <div className="text-xs font-black tracking-[0.25em] text-zinc-500">ぷるぷらす（Puru Plus）</div>
                <div className="mt-1 text-[clamp(1.8rem,8vw,3rem)] font-black tracking-tight text-zinc-900">ぷるぷらす</div>
                <div className="mt-1 text-xs font-semibold text-zinc-600 md:text-sm">スワイプ or クリックで合体。ぴったりを狙おう！</div>
              </div>

              <div className="grid w-full grid-cols-1 gap-3 sm:grid-cols-2">
                  <button
                  type="button"
                  onClick={() => {
                    void startBgm();
                    playSe("susumu");
                    setScreen("menu");
                  }}
                  className="flex-1 whitespace-nowrap rounded-[28px] bg-gradient-to-r from-emerald-400 to-cyan-400 px-6 py-4 text-base font-extrabold text-white shadow-[0_18px_30px_rgba(90,60,160,.20)] transition-transform hover:brightness-105 active:scale-[0.98]"
                >
                  遊ぶ
                </button>
                <button
                  type="button"
                  onClick={() => {
                    void startBgm();
                    playSe("susumu");
                    setIsRuleModalOpen(true);
                  }}
                  className="flex-1 whitespace-nowrap rounded-[28px] border border-white/70 bg-white/85 px-6 py-4 text-base font-extrabold text-zinc-800 shadow-[0_16px_0_rgba(255,255,255,.72)_inset,0_18px_30px_rgba(90,60,160,.14)] transition-transform hover:brightness-105 active:scale-[0.98]"
                >
                  遊び方
                </button>
                <button
                  type="button"
                  onClick={() => {
                    void startBgm();
                    playSe("susumu");
                    setScreen("settings");
                  }}
                  className="flex-1 whitespace-nowrap rounded-[28px] border border-white/70 bg-white/85 px-6 py-4 text-base font-extrabold text-zinc-800 shadow-[0_16px_0_rgba(255,255,255,.72)_inset,0_18px_30px_rgba(90,60,160,.14)] transition-transform hover:brightness-105 active:scale-[0.98]"
                >
                  設定
                </button>
                <button
                  type="button"
                  onClick={() => {
                    void startBgm();
                    playSe("susumu");
                    setStatsRefreshNonce((n) => n + 1);
                    setScreen("stats");
                  }}
                  className="flex-1 whitespace-nowrap rounded-[28px] border border-white/70 bg-white/85 px-6 py-4 text-base font-extrabold text-zinc-800 shadow-[0_16px_0_rgba(255,255,255,.72)_inset,0_18px_30px_rgba(90,60,160,.14)] transition-transform hover:brightness-105 active:scale-[0.98]"
                >
                  戦績
                </button>
              </div>
            </div>
          </motion.div>
        ) : screen === "settings" ? (
          <motion.div
            key="settings"
            className="fixed inset-0 z-40 flex items-center justify-center px-4 py-4 pb-[env(safe-area-inset-bottom)]"
            initial={{ opacity: 0, y: 10, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -10, scale: 0.98 }}
            transition={{ type: "spring", stiffness: 520, damping: 42, mass: 0.9 }}
          >
            <div className="flex max-h-full w-full max-w-2xl flex-col gap-5 overflow-y-auto rounded-[36px] border border-white/70 bg-gradient-to-b from-white/75 to-white/55 p-5 text-center shadow-[0_26px_90px_rgba(120,70,40,.18)] backdrop-blur md:rounded-[40px] md:p-7">
              <div className="space-y-1">
                <div className="text-xs font-black tracking-[0.25em] text-zinc-500">SETTING</div>
                <div className="text-3xl font-black tracking-tight text-zinc-900">音量設定</div>
              </div>

              <div className="rounded-[28px] border border-white/70 bg-white/75 p-4 text-left">
                <div className="text-sm font-black text-zinc-700">プレイヤー名</div>
                <div className="mt-1 text-xs font-semibold text-zinc-600">オンライン対戦で表示されます</div>
                <input
                  type="text"
                  value={playerName}
                  onChange={(e) => setPlayerName(e.target.value)}
                  placeholder="Player_1234"
                  maxLength={16}
                  className="mt-3 w-full rounded-2xl border border-white/70 bg-white/90 px-4 py-3 text-sm font-black text-zinc-800 shadow-[0_12px_0_rgba(255,255,255,.3)_inset]"
                />
              </div>

              <div className="grid w-full gap-6 sm:grid-cols-2">
                <div className="rounded-[28px] border border-white/70 bg-white/75 p-4">
                  <div className="text-sm font-black text-zinc-700">BGM</div>
                  <div className="mt-1 text-xs font-semibold text-zinc-600">
                    {bgmMuted ? "ミュート中" : "再生中"}
                  </div>
                  <button
                    type="button"
                    onClick={() => setBgmMuted((v) => !v)}
                    className="mt-3 w-full rounded-2xl border border-white/70 bg-white/85 px-4 py-3 text-sm font-black text-zinc-800 shadow-[0_12px_0_rgba(255,255,255,.72)_inset,0_14px_22px_rgba(90,60,160,.12)] transition-transform hover:brightness-105 active:scale-[0.98]"
                  >
                    {bgmMuted ? "🔇 BGMミュートON" : "🔊 BGMミュートOFF"}
                  </button>
                </div>
                <div className="rounded-[28px] border border-white/70 bg-white/75 p-4">
                  <div className="text-sm font-black text-zinc-700">SE</div>
                  <div className="mt-1 text-xs font-semibold text-zinc-600">
                    {seMuted ? "ミュート中" : "再生中"}
                  </div>
                  <button
                    type="button"
                    onClick={() => setSeMuted((v) => !v)}
                    className="mt-3 w-full rounded-2xl border border-white/70 bg-white/85 px-4 py-3 text-sm font-black text-zinc-800 shadow-[0_12px_0_rgba(255,255,255,.72)_inset,0_14px_22px_rgba(90,60,160,.12)] transition-transform hover:brightness-105 active:scale-[0.98]"
                  >
                    {seMuted ? "🔇 SEミュートON" : "🔊 SEミュートOFF"}
                  </button>
                </div>
              </div>

              <div className="flex flex-wrap justify-center gap-3 pb-[env(safe-area-inset-bottom)]">
                <button
                  type="button"
                  onClick={() => {
                    playSe("modoru");
                    setScreen("title");
                  }}
                  className="rounded-[28px] border border-white/70 bg-white/85 px-6 py-4 text-base font-extrabold text-zinc-800 shadow-[0_16px_0_rgba(255,255,255,.72)_inset,0_18px_30px_rgba(90,60,160,.14)] transition-transform hover:brightness-105 active:scale-[0.98]"
                >
                  戻る
                </button>
              </div>
            </div>
          </motion.div>
        ) : screen === "stats" ? (
          <motion.div
            key="stats"
            className="w-full"
            initial={{ opacity: 0, y: 10, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -10, scale: 0.98 }}
            transition={{ type: "spring", stiffness: 520, damping: 42, mass: 0.9 }}
          >
            <div className="flex flex-col gap-6 rounded-[36px] border border-white/70 bg-gradient-to-b from-white/75 to-white/55 p-7 text-center shadow-[0_26px_90px_rgba(120,70,40,.18)] backdrop-blur md:rounded-[40px]">
              <header className="flex items-center justify-between gap-3">
                <div className="space-y-1 text-left">
                  <div className="text-xs font-black tracking-[0.25em] text-zinc-500">STATS</div>
                  <div className="text-3xl font-black tracking-tight text-zinc-900">戦績</div>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    playSe("modoru");
                    setScreen("title");
                  }}
                  className="rounded-2xl border border-white/70 bg-white/85 px-4 py-2 text-xs font-black text-zinc-800 shadow-[0_14px_0_rgba(255,255,255,.72)_inset,0_18px_30px_rgba(90,60,160,.12)] transition-transform hover:brightness-105 active:scale-[0.98]"
                >
                  戻る
                </button>
              </header>

              {statsLoading && (
                <div className="rounded-[28px] border border-white/70 bg-white/75 px-6 py-8 text-center text-sm font-black text-zinc-700">
                  読み込み中...
                </div>
              )}

              {!statsLoading && statsError && (
                <div className="rounded-[28px] border border-rose-200 bg-rose-50 px-6 py-8 text-center text-sm font-black text-rose-900">
                  {statsError}
                </div>
              )}

              {!statsLoading && statsPayload && (
                <>
                  {!statsPayload.hasAnyHistory ? (
                    <div className="rounded-[28px] border border-emerald-200 bg-emerald-50 px-6 py-8 text-center text-sm font-black text-emerald-900">
                      まだデータがありません。たくさん遊んで記録を残そう！
                    </div>
                  ) : (
                    <div className="grid w-full gap-4 md:grid-cols-2">
                      <div className="rounded-[28px] border border-sky-200 bg-sky-50 px-5 py-5 text-left">
                        <div className="text-xs font-black tracking-[0.25em] text-sky-700/90">A. オンライン</div>
                        <div className="mt-2 text-sm font-black text-zinc-900">現在のレート: {statsPayload.currentRate}</div>
                        <div className="mt-1 text-sm font-black text-zinc-900">
                          通算試合数: {statsPayload.onlineMatches} / 勝率:{" "}
                          {statsPayload.onlineWinRate === null ? "-" : `${statsPayload.onlineWinRate}%`}
                        </div>
                        <div className="mt-2 text-xs font-semibold text-sky-900/80">
                          Wins: {statsPayload.onlineWins}
                        </div>
                      </div>

                      <div className="rounded-[28px] border border-emerald-200 bg-emerald-50 px-5 py-5 text-left">
                        <div className="text-xs font-black tracking-[0.25em] text-emerald-700/90">B. CPU</div>
                        <div className="mt-2 space-y-1 text-sm font-black text-zinc-900">
                          <div>Easy: {statsPayload.cpuWins.easy}</div>
                          <div>Normal: {statsPayload.cpuWins.normal}</div>
                          <div>Hard: {statsPayload.cpuWins.hard}</div>
                          <div>God: {statsPayload.cpuWins.god}</div>
                        </div>
                      </div>

                      <div className="rounded-[28px] border border-fuchsia-200 bg-fuchsia-50 px-5 py-5 text-left md:col-span-2">
                        <div className="text-xs font-black tracking-[0.25em] text-fuchsia-700/90">C. プレイスタイル</div>
                        <div className="mt-3 flex flex-wrap items-center gap-3">
                          <div className="rounded-[999px] border border-white/70 bg-white/75 px-4 py-2 text-sm font-black text-zinc-900">
                            25を作るまでの平均ターン:{" "}
                            {statsPayload.avgTurnsToGoal25 === null ? "-" : `${statsPayload.avgTurnsToGoal25}ターン`}
                          </div>
                          <div className="rounded-[999px] border border-white/70 bg-white/75 px-4 py-2 text-sm font-black text-zinc-900">
                            最大連勝数: {statsPayload.maxWinStreak}
                          </div>
                        </div>
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          </motion.div>
        ) : screen === "menu" ? (
          <motion.div
            key="menu"
            className="w-full min-h-[100dvh] overflow-y-auto pb-10"
            initial={{ opacity: 0, y: 10, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -10, scale: 0.98 }}
            transition={{ type: "spring", stiffness: 520, damping: 42, mass: 0.9 }}
          >
            <div className="flex flex-col gap-3 rounded-[36px] border border-white/70 bg-gradient-to-b from-white/75 to-white/55 p-3 shadow-[0_26px_90px_rgba(120,70,40,.18)] backdrop-blur md:rounded-[40px] md:p-5">
              <header className="space-y-1 flex-shrink-0">
                <div className="text-xs font-black tracking-[0.25em] text-zinc-500">ぷるぷらす（Puru Plus）</div>
                <motion.div
                  className="text-[clamp(1.8rem,8vw,3rem)] font-black tracking-tight"
                  initial={{ scale: 0.9, y: 6, rotate: -1, opacity: 0 }}
                  animate={{
                    scale: [1, 1.03, 1],
                    y: [0, -2, 0],
                    rotate: [0, -0.6, 0],
                    opacity: 1,
                  }}
                  transition={{
                    type: "tween",
                    duration: 0.55,
                    ease: "easeInOut",
                    repeat: Infinity,
                    repeatDelay: 5.5,
                  }}
                  style={{
                    textShadow:
                      "0 3px 0 rgba(255,255,255,.85), 0 10px 26px rgba(120,70,40,.16), 0 1px 0 rgba(40,30,70,.12)",
                    WebkitTextStroke: "6px rgba(160,210,255,.55)",
                    paintOrder: "stroke fill",
                  }}
                >
                  <span
                    style={{
                      WebkitTextStroke: "10px rgba(255,170,210,.40)",
                      paintOrder: "stroke fill",
                    }}
                    className="bg-gradient-to-r from-pink-400 via-fuchsia-400 to-sky-400 bg-clip-text text-transparent"
                  >
                    ぷるぷらす
                  </span>
                </motion.div>
                <div className="text-2xl font-black tracking-tight md:text-4xl">モード選択</div>
                <div className="text-xs font-semibold text-zinc-600 md:text-base">
                  スワイプ or クリックで合体。ぴったり {menuTarget} を狙おう！
                </div>
                <div className="flex justify-end">
                  <button
                    type="button"
                    onClick={() => {
                      playSe("modoru");
                      setScreen("title");
                    }}
                    className="rounded-2xl border border-white/70 bg-white/85 px-4 py-2 text-xs font-black text-zinc-800 shadow-[0_14px_0_rgba(255,255,255,.72)_inset,0_18px_30px_rgba(90,60,160,.12)] transition-transform hover:brightness-105 active:scale-[0.98]"
                  >
                    タイトルへ戻る
                  </button>
                </div>
              </header>

              <div className="grid gap-2 p-4 md:grid-cols-2">
                <div className="rounded-[30px] border border-white/70 bg-gradient-to-b from-white/80 to-white/60 p-3 shadow-[0_22px_60px_rgba(120,70,40,.16)]">
                  <div className="flex items-center justify-between gap-3">
                    <div className="text-xs font-black tracking-widest text-zinc-700">対戦モード</div>
                    <div className="flex items-center gap-2 text-[10px] font-black text-zinc-600">
                      <JellyImage src="/images/vs_player.png" alt="対人" ring="rgba(255,170,210,.95)" size={34} />
                      <JellyImage src="/images/vs_cpu.png" alt="CPU" ring="rgba(150,200,255,.95)" size={34} />
                      <JellyImage src="/images/vs_online.png" alt="オンライン" ring="rgba(160,255,210,.95)" size={34} />
                    </div>
                  </div>
                  <div className="mt-2 grid grid-cols-3 gap-2">
                    <JellySelectButton
                      selected={menuMode === "local"}
                      onClick={() => {
                        playSe("sentaku");
                        setMenuMode("local");
                      }}
                      label="対人"
                      variant="tile"
                      imgSrc="/images/vs_player.png"
                      imgAlt="対人"
                      ring="rgba(255,170,210,.95)"
                      imgSize={40}
                    />
                    <JellySelectButton
                      selected={menuMode === "cpu"}
                      onClick={() => {
                        playSe("sentaku");
                        setMenuMode("cpu");
                      }}
                      label="CPU"
                      variant="tile"
                      imgSrc="/images/vs_cpu.png"
                      imgAlt="CPU"
                      ring="rgba(150,200,255,.95)"
                      imgSize={40}
                    />
                    <JellySelectButton
                      selected={menuMode === "online"}
                      onClick={() => {
                        playSe("sentaku");
                        setMenuMode("online");
                      }}
                      label="オンライン"
                      variant="tile"
                      imgSrc="/images/vs_online.png"
                      imgAlt="オンライン"
                      ring="rgba(160,255,210,.95)"
                      imgSize={40}
                    />
                  </div>
                </div>

                <div className="rounded-[28px] border border-white/70 bg-white/75 p-4 shadow-[0_12px_30px_rgba(80,60,130,.10)]">
                  <div className="text-xs font-black tracking-widest text-zinc-500">ゴール数値（25がおすすめ）</div>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {[20, 25, 30, 40, 50].map((t) => (
                      <motion.button
                        key={t}
                        type="button"
                        onClick={() => {
                          playSe("sentaku");
                          setMenuTarget(t);
                        }}
                        className={[
                          "whitespace-nowrap rounded-[999px] border px-5 py-3 text-sm font-extrabold shadow-[0_18px_0_rgba(255,255,255,.7)_inset,0_18px_34px_rgba(90,60,160,.14)] transition-transform active:scale-[0.98]",
                          menuTarget === t
                            ? "border-white bg-gradient-to-r from-emerald-200 to-cyan-200 text-zinc-800"
                            : "border-white/70 bg-white/80 text-zinc-700 hover:brightness-105",
                        ].join(" ")}
                        aria-pressed={menuTarget === t}
                        whileHover={{ y: -1 }}
                        whileTap={{ scale: 0.98, y: 0 }}
                      >
                        {t}
                      </motion.button>
                    ))}
                  </div>
                </div>

                <div className="rounded-[28px] border border-white/70 bg-white/75 p-4 shadow-[0_12px_30px_rgba(80,60,130,.10)]">
                  <div className="text-xs font-black tracking-widest text-zinc-500">先攻/後攻</div>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {(
                      [
                        { id: "p1", label: "自分（P1）" },
                        { id: "p2", label: "相手（P2）" },
                        { id: "random", label: "ランダム" },
                      ] as const
                    ).map((o) => (
                      <button
                        key={o.id}
                        type="button"
                        onClick={() => {
                          playSe("sentaku");
                          setMenuFirstTurn(o.id);
                        }}
                        className={[
                          "whitespace-nowrap rounded-[999px] border px-5 py-3 text-sm font-extrabold shadow-[0_18px_0_rgba(255,255,255,.7)_inset,0_18px_34px_rgba(90,60,160,.14)] transition-transform active:scale-[0.98]",
                          menuFirstTurn === o.id
                            ? "border-white bg-gradient-to-r from-amber-200 to-fuchsia-200 text-zinc-800"
                            : "border-white/70 bg-white/80 text-zinc-700 hover:brightness-105",
                        ].join(" ")}
                        aria-pressed={menuFirstTurn === o.id}
                      >
                        {o.label}
                      </button>
                    ))}
                  </div>

                  <div className="mt-4 text-xs font-black tracking-widest text-zinc-500">制限時間</div>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {(
                      [
                        { id: "3", label: "3秒" },
                        { id: "15", label: "15秒" },
                        { id: "30", label: "30秒" },
                        { id: "none", label: "制限なし" },
                      ] as const
                    ).map((o) => (
                      <button
                        key={o.id}
                        type="button"
                        onClick={() => {
                          playSe("sentaku");
                          setMenuTimeLimit(o.id);
                        }}
                        className={[
                          "whitespace-nowrap rounded-[999px] border px-5 py-3 text-sm font-extrabold shadow-[0_18px_0_rgba(255,255,255,.7)_inset,0_18px_34px_rgba(90,60,160,.14)] transition-transform active:scale-[0.98]",
                          menuTimeLimit === o.id
                            ? "border-white bg-gradient-to-r from-emerald-200 to-cyan-200 text-zinc-800"
                            : "border-white/70 bg-white/80 text-zinc-700 hover:brightness-105",
                        ].join(" ")}
                        aria-pressed={menuTimeLimit === o.id}
                      >
                        {o.label}
                      </button>
                    ))}
                  </div>
                </div>

                {menuMode === "cpu" && (
                  <div className="rounded-[30px] border border-white/70 bg-gradient-to-b from-white/80 to-white/60 p-3 shadow-[0_22px_60px_rgba(120,70,40,.16)]">
                    <div className="flex items-center justify-between gap-3">
                      <div className="text-xs font-black tracking-widest text-zinc-700">難易度</div>
                      <div className="flex items-center gap-2">
                        <JellyImage src="/images/easy.png" alt="Easy" ring="rgba(255,220,120,.95)" size={34} />
                        <JellyImage src="/images/normal.png" alt="Normal" ring="rgba(150,200,255,.95)" size={34} />
                        <JellyImage src="/images/hard.png" alt="Hard" ring="rgba(210,160,255,.95)" size={34} />
                        <JellyImage src="/images/god.png" alt="God" ring="rgba(255,170,120,.95)" size={34} />
                      </div>
                    </div>
                    <div className="mt-2 grid grid-cols-2 gap-2">
                      {(
                        [
                          { id: "easy", label: "Easy", ring: "rgba(255,220,120,.95)", src: "/images/easy.png" },
                          { id: "normal", label: "Normal", ring: "rgba(150,200,255,.95)", src: "/images/normal.png" },
                          { id: "hard", label: "Hard", ring: "rgba(210,160,255,.95)", src: "/images/hard.png" },
                          { id: "god", label: "God", ring: "rgba(255,170,120,.95)", src: "/images/god.png" },
                        ] as const
                      ).map((o) => {
                        const locked = !unlockedDifficulties.includes(o.id);
                        return (
                          <JellySelectButton
                            key={o.id}
                            selected={menuDifficulty === o.id}
                            disabled={locked}
                            onClick={() => {
                              if (!locked) {
                                playSe("sentaku");
                                setMenuDifficulty(o.id);
                              }
                            }}
                            label={o.label}
                            variant="tile"
                            imgSrc={o.src}
                            imgAlt={o.label}
                            ring={o.ring}
                            imgSize={40}
                          />
                        );
                      })}
                    </div>
                  </div>
                )}

                {menuMode === "online" && (
                  <div className="rounded-[28px] border border-white/70 bg-white/75 p-4 shadow-[0_12px_30px_rgba(80,60,130,.10)]">
                    <div className="text-xs font-black tracking-widest text-zinc-500">オンライン対戦</div>
                    <div className="mt-2 flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          playSe("sentaku");
                          setMenuOnlineRole("host");
                        }}
                        className={[
                          "whitespace-nowrap rounded-[999px] border px-5 py-3 text-sm font-extrabold shadow-[0_18px_0_rgba(255,255,255,.7)_inset,0_18px_34px_rgba(90,60,160,.14)]",
                          menuOnlineRole === "host"
                            ? "border-white bg-gradient-to-r from-amber-200 to-pink-200 text-zinc-800"
                            : "border-white/70 bg-white/80 text-zinc-700",
                        ].join(" ")}
                        aria-pressed={menuOnlineRole === "host"}
                      >
                        ルーム作成（P1）
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          playSe("sentaku");
                          setMenuOnlineRole("guest");
                        }}
                        className={[
                          "whitespace-nowrap rounded-[999px] border px-5 py-3 text-sm font-extrabold shadow-[0_18px_0_rgba(255,255,255,.7)_inset,0_18px_34px_rgba(90,60,160,.14)]",
                          menuOnlineRole === "guest"
                            ? "border-white bg-gradient-to-r from-sky-200 to-fuchsia-200 text-zinc-800"
                            : "border-white/70 bg-white/80 text-zinc-700",
                        ].join(" ")}
                        aria-pressed={menuOnlineRole === "guest"}
                      >
                        ルーム参加（P2）
                      </button>
                    </div>
                    <div className="mt-3 flex items-center gap-2">
                      <input
                        value={menuRoomId}
                        onChange={(e) => setMenuRoomId(e.target.value)}
                        placeholder="ルームID（例: abc123）"
                        className="w-full rounded-2xl border border-white/70 bg-white px-4 py-3 text-sm font-bold text-zinc-800 outline-none"
                      />
                      <button
                        type="button"
                        onClick={() => {
                          playSe("sentaku");
                          setMenuRoomId(Math.random().toString(36).slice(2, 8));
                        }}
                        className="shrink-0 whitespace-nowrap rounded-2xl border border-white/70 bg-white/85 px-4 py-3 text-sm font-extrabold text-zinc-800 shadow-[0_14px_0_rgba(255,255,255,.7)_inset]"
                      >
                        生成
                      </button>
                    </div>
                    <div className="mt-2 text-xs font-semibold text-zinc-500">
                      同じルームIDで接続すると同期します（ゲストはホストの開始を待ちます）
                    </div>
                  </div>
                )}
              </div>

              <div className="mt-2 flex flex-col gap-2 p-4 pb-[max(env(safe-area-inset-bottom),1rem)]">
                <button
                  type="button"
                  onClick={startRandomMatch}
                  className="w-full whitespace-nowrap rounded-[28px] border border-white/70 bg-white/85 px-6 py-3 text-base font-extrabold text-zinc-800 shadow-[0_16px_0_rgba(255,255,255,.72)_inset,0_18px_30px_rgba(90,60,160,.14)] transition-transform hover:brightness-105 active:scale-[0.98]"
                >
                  レートマッチ
                </button>
                <div className="text-center text-xs font-semibold text-zinc-600">
                  勝敗に応じてレートが変動するオンライン対戦モードです
                </div>
                <button
                  type="button"
                  onClick={startGame}
                  className="w-full whitespace-nowrap rounded-[28px] bg-gradient-to-r from-emerald-400 to-cyan-400 px-6 py-3 text-base font-extrabold text-white shadow-[0_18px_30px_rgba(90,60,160,.20)] transition-transform hover:brightness-105 active:scale-[0.98]"
                >
                  ゲームスタート
                </button>
              </div>
            </div>
          </motion.div>
        ) : screen === "matching" ? (
          <motion.div
            key="matching"
            className="w-full"
            initial={{ opacity: 0, y: 10, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -10, scale: 0.98 }}
            transition={{ type: "spring", stiffness: 520, damping: 42, mass: 0.9 }}
          >
            <div className="relative flex flex-col items-center gap-6 rounded-[36px] border border-white/70 bg-gradient-to-b from-white/75 to-white/55 p-7 text-center shadow-[0_26px_90px_rgba(120,70,40,.18)] backdrop-blur md:rounded-[40px]">
              <button
                type="button"
                onClick={() => void cancelMatchingAndBackToMenu()}
                className="absolute left-4 top-4 rounded-2xl border border-white/70 bg-white/85 px-4 py-2 text-xs font-black text-zinc-800 shadow-[0_14px_0_rgba(255,255,255,.72)_inset,0_18px_30px_rgba(90,60,160,.12)] transition-transform hover:brightness-105 active:scale-[0.98]"
              >
                戻る（キャンセル）
              </button>
              <div className="text-xs font-black tracking-[0.25em] text-zinc-500">MATCHING</div>
              <div className="text-3xl font-black tracking-tight text-zinc-900">対戦相手を探しています...</div>
              <div className="text-sm font-semibold text-zinc-600">最大15秒ほどかかる場合があります</div>
              <div className="text-sm font-semibold text-zinc-600">
                Your Rate: {playerRate}
              </div>
              <motion.div
                className="h-3 w-64 overflow-hidden rounded-full border border-white/70 bg-white/80"
                initial={false}
              >
                <motion.div
                  className="h-full bg-gradient-to-r from-sky-300 to-fuchsia-300"
                  animate={{ x: ["-40%", "120%"] }}
                  transition={{ duration: 1.2, repeat: Infinity, ease: "easeInOut" }}
                />
              </motion.div>

              {matchNotFound && (
                <div className="rounded-3xl border border-white/70 bg-white/85 px-5 py-4 text-sm font-black text-zinc-800 shadow-[0_14px_0_rgba(255,255,255,.72)_inset,0_18px_30px_rgba(90,60,160,.12)]">
                  見つかりませんでした。
                </div>
              )}

              {matchNotFound && (
                <button
                  type="button"
                  onClick={() => void cancelMatchingAndBackToMenu()}
                  className="rounded-3xl border border-white/70 bg-white/85 px-5 py-4 text-sm font-black text-zinc-800 shadow-[0_16px_0_rgba(255,255,255,.72)_inset,0_18px_30px_rgba(90,60,160,.14)] transition-transform hover:brightness-105 active:scale-[0.98]"
                >
                  キャンセルしてタイトルへ戻る
                </button>
              )}
            </div>
          </motion.div>
        ) : screen === "onlineWaiting" ? (
        <motion.div
          key="onlineWaiting"
          className="w-full"
          initial={{ opacity: 0, y: 10, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -10, scale: 0.98 }}
          transition={{ type: "spring", stiffness: 520, damping: 42, mass: 0.9 }}
        >
          <div className="relative flex flex-col items-center gap-6 rounded-[36px] border border-white/70 bg-gradient-to-b from-white/75 to-white/55 p-7 text-center shadow-[0_26px_90px_rgba(120,70,40,.18)] backdrop-blur md:rounded-[40px]">
            <button
              type="button"
              onClick={() => backToMenu()}
              className="absolute left-4 top-4 rounded-2xl border border-white/70 bg-white/85 px-4 py-2 text-xs font-black text-zinc-800 shadow-[0_14px_0_rgba(255,255,255,.72)_inset,0_18px_30px_rgba(90,60,160,.12)] transition-transform hover:brightness-105 active:scale-[0.98]"
            >
              戻る（キャンセル）
            </button>
            <div className="text-xs font-black tracking-[0.25em] text-zinc-500">ONLINE</div>
            <div className="text-3xl font-black tracking-tight text-zinc-900">
              相手を待っています...
              {matchType === "random" ? null : (
                <span className="text-sm font-semibold text-zinc-600">(Room ID: {onlineWaitingRoomId})</span>
              )}
            </div>
            <div className="flex flex-wrap items-center justify-center gap-2 pt-1">
              <div className="rounded-[999px] border border-white/70 bg-white/75 px-3 py-1 text-xs font-black text-zinc-800 shadow-[0_12px_0_rgba(255,255,255,.7)_inset,0_14px_20px_rgba(90,60,160,.10)]">
                あなた: {onlineRoleLabel.myText}
              </div>
              <div className="rounded-[999px] border border-white/70 bg-white/75 px-3 py-1 text-xs font-black text-zinc-800 shadow-[0_12px_0_rgba(255,255,255,.7)_inset,0_14px_20px_rgba(90,60,160,.10)]">
                相手: {onlineRoleLabel.oppText}
              </div>
            </div>

            {matchType === "random" && (
              <div className="flex flex-wrap items-center justify-center gap-2 pt-1">
                <div className="rounded-[999px] border border-white/70 bg-white/75 px-3 py-1 text-xs font-black text-zinc-800 shadow-[0_12px_0_rgba(255,255,255,.7)_inset,0_14px_20px_rgba(90,60,160,.10)]">
                  {playerName} (Rate: {playerRate})
                </div>
                <div className="rounded-[999px] border border-white/70 bg-white/75 px-3 py-1 text-xs font-black text-zinc-800 shadow-[0_12px_0_rgba(255,255,255,.7)_inset,0_14px_20px_rgba(90,60,160,.10)]">
                  {onlineOpponentName || "Opponent"} (
                  Rate: {rateLoading || !onlineOpponentUserId ? "???" : opponentRateForDisplay})
                </div>
              </div>
            )}
            <motion.div
              className="h-3 w-64 overflow-hidden rounded-full border border-white/70 bg-white/80"
              initial={false}
            >
              <motion.div
                className="h-full bg-gradient-to-r from-sky-300 to-fuchsia-300"
                animate={{ x: ["-40%", "120%"] }}
                transition={{ duration: 1.2, repeat: Infinity, ease: "easeInOut" }}
              />
            </motion.div>
          </div>
        </motion.div>
      ) : (
        <motion.div
          key="play"
          className="w-full min-h-[100dvh] overflow-y-auto pb-20 pb-[env(safe-area-inset-bottom)]"
          initial={{ opacity: 0, y: 10, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -10, scale: 0.98 }}
          transition={{ type: "spring", stiffness: 520, damping: 42, mass: 0.9 }}
        >
          <div className="flex flex-col gap-4 rounded-[36px] border border-white/70 bg-gradient-to-b from-white/75 to-white/55 p-3 shadow-[0_26px_90px_rgba(120,70,40,.18)] backdrop-blur md:gap-6 md:rounded-[40px] md:p-6">
            <header className="flex flex-shrink-0 flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
              <div className="space-y-2">
                <div className="flex w-full items-center justify-between gap-3">
                  <div className="text-xs font-black tracking-[0.25em] text-zinc-500">ぷるぷらす（Puru Plus）</div>
                  <button
                    type="button"
                    onClick={() => setHelpOpen(true)}
                    aria-label="ヘルプ"
                    className="grid h-8 w-8 place-items-center rounded-full border border-white/70 bg-white/85 text-zinc-800 shadow-[0_14px_30px_rgba(80,60,130,.10)] transition-transform hover:brightness-105 active:scale-[0.98]"
                  >
                    <span className="text-xs font-black">?</span>
                  </button>
                </div>

                <div className="flex flex-col items-center gap-2">
                  {isOnlineBattle && (
                    <div className="rounded-[999px] border border-white/70 bg-white/75 px-3 py-1 text-xs font-black text-zinc-800 shadow-[0_12px_0_rgba(255,255,255,.7)_inset,0_14px_20px_rgba(90,60,160,.10)]">
                      {matchType === "random"
                        ? `${playerName} (Rate: ${playerRate})${
                            online?.player === 1 ? " (YOU / P1)" : online?.player === 2 ? " (YOU / P2)" : ""
                          } VS ${
                            onlineOpponentName || "Opponent"
                          } (Rate: ${opponentRateForDisplay})`
                        : `${playerName}${
                            online?.player === 1 ? " (YOU / P1)" : online?.player === 2 ? " (YOU / P2)" : ""
                          } vs ${onlineOpponentName || "Opponent"}`}
                    </div>
                  )}

                  <div className="flex flex-wrap items-baseline justify-center gap-3">
                    {/* レイアウトシフト防止のため、表示/非表示でも高さを固定 */}
                    <div className="min-h-[28px]">
                      <div
                        className="rounded-[999px] border border-white/70 bg-white/75 px-3 py-1 text-xs font-black text-zinc-700 shadow-[0_12px_0_rgba(255,255,255,.7)_inset,0_14px_20px_rgba(90,60,160,.10)]"
                        style={{ visibility: showThinking ? "visible" : "hidden" }}
                      >
                        相手が考え中...
                      </div>
                    </div>

                    {!winner && (
                      <div className="rounded-[999px] border border-white/70 bg-white/75 px-3 py-1 text-xs font-black text-zinc-700 shadow-[0_12px_0_rgba(255,255,255,.7)_inset,0_14px_20px_rgba(90,60,160,.10)]">
                        {movesLeftText}
                      </div>
                    )}

                    {!winner && (
                      <motion.div
                        className={[
                          "rounded-[999px] border px-3 py-1 text-xs font-black shadow-[0_12px_0_rgba(255,255,255,.7)_inset,0_14px_20px_rgba(90,60,160,.10)]",
                          timeLeftSec !== null && timeLeftSec <= 10
                            ? "border-red-300 bg-red-50 text-red-700"
                            : "border-white/70 bg-white/75 text-zinc-700",
                        ].join(" ")}
                        animate={timeLeftSec !== null && timeLeftSec <= 10 ? { x: [0, -2, 2, -2, 2, 0] } : { x: 0 }}
                        transition={
                          timeLeftSec !== null && timeLeftSec <= 10 ? { duration: 0.35, repeat: Infinity } : { duration: 0.2 }
                        }
                      >
                        {timeLeftSec === null ? "∞" : `${timeLeftSec}s`}
                      </motion.div>
                    )}
                  </div>

                  {!winner && (
                    <div className="h-3 w-full max-w-sm overflow-hidden rounded-full border border-white/70 bg-white/70">
                      <motion.div
                        className={
                          timeLeftSec !== null && timeLeftSec <= 10
                            ? "h-full bg-red-400"
                            : "h-full bg-gradient-to-r from-emerald-300 to-cyan-300"
                        }
                        animate={{
                          width: `${
                            timeLeftMs === null || timeLimitMsRef.current === null
                              ? 100
                              : Math.min(100, Math.max(0, (timeLeftMs / timeLimitMsRef.current) * 100))
                          }%`,
                        }}
                        transition={{ duration: 0.12, ease: "linear" }}
                      />
                    </div>
                  )}

                  {/* レイアウトシフト防止：表示/非表示でも高さ固定 */}
                  <div className="min-h-[46px] flex items-center">
                    <motion.div
                      key="cpu-fallback"
                      initial={false}
                      animate={{ opacity: cpuFallbackMessage ? 1 : 0, y: cpuFallbackMessage ? 0 : 6 }}
                      transition={{ duration: 0.2 }}
                      style={{ visibility: cpuFallbackMessage ? "visible" : "hidden" }}
                      className="rounded-[18px] border border-emerald-200/80 bg-emerald-50 px-5 py-3 text-sm font-black text-emerald-900 shadow-[0_14px_30px_rgba(16,185,129,.10)]"
                    >
                      {cpuFallbackMessage ?? "対戦相手が見つかりました！"}
                    </motion.div>
                  </div>

                  <div className="text-sm font-semibold text-zinc-600 md:text-base">
                    合計が{" "}
                    <span className="inline-flex items-baseline gap-1 rounded-[999px] border border-white/70 bg-white/80 px-3 py-1 font-black text-zinc-900 shadow-[0_12px_0_rgba(255,255,255,.7)_inset,0_14px_20px_rgba(90,60,160,.10)]">
                      <span className="text-[10px] font-black tracking-widest text-zinc-600">GOAL</span>
                      <span className="text-xl font-black tabular-nums">{target}</span>
                    </span>{" "}
                    ぴったりで勝利！
                  </div>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-3 sm:justify-end">
                {matchType !== "random" ? (
                  <div className="flex items-center gap-2 rounded-3xl border border-white/70 bg-white/75 px-3 py-3 shadow-[0_12px_30px_rgba(80,60,130,.10)]">
                    {isOnlineBattle ? (
                      <>
                        <JellyImage
                          src="/images/vs_online.png"
                          alt="online"
                          ring="rgba(160,255,210,.95)"
                          size={38}
                        />
                        <div className="leading-tight">
                          <div className="text-[10px] font-black tracking-widest text-zinc-600">VS</div>
                          <div className="text-xs font-black text-zinc-800">
                            {playerName} vs {onlineOpponentName || "Opponent"}
                          </div>
                        </div>
                      </>
                    ) : (
                      <>
                        <JellyImage
                          src={
                            mode === "local"
                              ? "/images/vs_player.png"
                              : mode === "cpu"
                                ? "/images/vs_cpu.png"
                                : "/images/vs_online.png"
                          }
                          alt="mode"
                          ring={
                            mode === "local"
                              ? "rgba(255,170,210,.95)"
                              : mode === "cpu"
                                ? "rgba(150,200,255,.95)"
                                : "rgba(160,255,210,.95)"
                          }
                          size={38}
                        />
                        {mode === "cpu" && !onlineBotFallback ? (
                          <JellyImage
                            src={
                              cpuDifficulty === "easy"
                                ? "/images/easy.png"
                                : cpuDifficulty === "normal"
                                  ? "/images/normal.png"
                                  : cpuDifficulty === "hard"
                                    ? "/images/hard.png"
                                    : "/images/god.png"
                            }
                            alt="difficulty"
                            ring={
                              cpuDifficulty === "easy"
                                ? "rgba(255,220,120,.95)"
                                : cpuDifficulty === "normal"
                                  ? "rgba(150,200,255,.95)"
                                  : cpuDifficulty === "hard"
                                    ? "rgba(210,160,255,.95)"
                                    : "rgba(255,170,120,.95)"
                            }
                            size={38}
                          />
                        ) : null}
                        <div className="leading-tight">
                          <div className="text-[10px] font-black tracking-widest text-zinc-600">MODE</div>
                          <div className="text-xs font-black text-zinc-800">
                            {mode === "local"
                              ? "対人"
                              : mode === "cpu"
                                ? `CPU / ${cpuDifficulty.toUpperCase()}`
                                : "オンライン"}
                          </div>
                        </div>
                      </>
                    )}
                  </div>
                ) : null}
              </div>
            </header>

            <section className="flex w-full flex-col items-center gap-4 md:gap-5">
              <div className="flex w-full max-w-[560px] flex-col items-center gap-3">
                {!winner && (
                  <div className="w-full max-w-sm">
                    <div className="relative h-12 rounded-[999px] border border-white/70 bg-white/75 p-1 shadow-[0_14px_0_rgba(255,255,255,.7)_inset,0_18px_30px_rgba(90,60,160,.12)]">
                      <motion.div
                        className={`absolute top-1 h-10 w-[calc(50%-4px)] rounded-[999px] bg-gradient-to-r ${playerAccent(
                          currentPlayer,
                        )} shadow-[0_18px_30px_rgba(90,60,160,.22)]`}
                        animate={{ left: currentPlayer === 1 ? 4 : "calc(50% + 0px)" }}
                        transition={{ type: "spring", stiffness: 520, damping: 38 }}
                        aria-hidden="true"
                      />
                      <div className="relative grid h-full grid-cols-2 place-items-center text-sm font-black text-white">
                        <div className="drop-shadow-[0_2px_0_rgba(0,0,0,.15)]">P1</div>
                        <div className="drop-shadow-[0_2px_0_rgba(0,0,0,.15)]">P2</div>
                      </div>
                    </div>
                  </div>
                )}

                {/* GameCoreUnit: モバイルは縦並び、sm以上は盤面とNEXTを横並び */}
                <div className="flex w-full max-w-[560px] flex-col items-center gap-3 sm:flex-row sm:items-start sm:justify-center">
                  <div className="w-full max-w-sm rounded-3xl border border-white/70 bg-white/72 p-3 shadow-[0_16px_34px_rgba(90,60,160,.12)] sm:order-2 sm:w-[170px] sm:max-w-none">
                    <div className="flex items-end justify-between gap-3 sm:flex-col sm:items-start">
                      <div className="text-xs font-black tracking-widest text-zinc-500">NEXT</div>
                      <div className="text-[10px] font-black text-zinc-500">自動で補充</div>
                    </div>
                    <div className="mt-2 flex items-center justify-center gap-2 sm:mt-3 sm:flex-col">
                      <div className="grid h-12 w-12 place-items-center rounded-3xl border border-white/70 bg-white text-2xl font-black tabular-nums text-zinc-800 shadow-[0_14px_0_rgba(255,255,255,.7)_inset,0_16px_26px_rgba(90,60,160,.12)]">
                        {nextPair.n0}
                      </div>
                      <div className="grid h-12 w-12 place-items-center rounded-3xl border border-white/70 bg-white/85 text-xl font-black tabular-nums text-zinc-800 shadow-[0_14px_0_rgba(255,255,255,.7)_inset,0_16px_26px_rgba(90,60,160,.12)]">
                        {nextPair.n1}
                      </div>
                    </div>
                  </div>

                  <div className="flex w-full max-h-[60dvh] items-center justify-center sm:order-1 sm:flex-1">
                <div className="relative aspect-square w-[min(100%,60dvh)] touch-none overscroll-contain sm:w-full sm:max-w-[460px]" ref={boardWrapRef}>
                  <div className="grid grid-cols-2 gap-3 rounded-[36px] border border-white/70 bg-white/65 p-3 shadow-[0_18px_60px_rgba(90,60,160,.14)] md:gap-4 md:rounded-[44px] md:p-4">
                    {board.map((value, idx) => {
                      const isSelected = selected === idx;
                      const isFlashing = flashIndex === idx;
                      const isWinningTile = value === targetRef.current;
                      const isMovingPair =
                        moveOverlay && (idx === moveOverlay.from || idx === moveOverlay.to);

                      return (
                        <motion.button
                          key={idx}
                          type="button"
                          onClick={() => handleTileClick(idx)}
                          onTouchStart={(e) => handleTouchStart(idx, e)}
                          onTouchEnd={(e) => handleTouchEnd(idx, e)}
                          disabled={!canInteract}
                          className={[
                            "relative grid h-24 w-24 select-none place-items-center rounded-3xl border-2 touch-none sm:h-28 sm:w-28",
                            "md:h-32 md:w-32",
                            "transition-[filter,transform] duration-150 active:scale-[0.98]",
                            "outline-none focus-visible:ring-4 focus-visible:ring-white/70 focus-visible:ring-offset-0",
                            canInteract ? "cursor-pointer" : "cursor-default opacity-95",
                            isSelected ? "ring-4 ring-white/70" : "ring-0",
                            isFlashing ? "tile-flash" : "",
                            isWinningTile ? "ring-4 ring-emerald-400/60" : "",
                          isMovingPair ? "opacity-0 scale-[0.85]" : "",
                          ].join(" ")}
                          style={
                            isMovingPair
                              ? { background: "transparent", borderColor: "transparent", boxShadow: "none" }
                              : tileStyle(value, targetRef.current)
                          }
                          aria-label={`Tile ${idx + 1}: ${value}`}
                          ref={(el) => {
                            tileRefs.current[idx] = el;
                          }}
                          animate={bumpIds[idx] ? { scale: [1, 1.09, 0.98, 1] } : { scale: 1 }}
                          transition={{ type: "tween", duration: 0.26, ease: "easeOut" }}
                        >
                          <div className="absolute inset-0 rounded-3xl bg-[radial-gradient(circle_at_30%_20%,rgba(255,255,255,.95),transparent_55%)] opacity-80" />
                          <div className="absolute inset-0 rounded-3xl bg-gradient-to-b from-white/30 to-transparent opacity-70" />
                          <div className="relative text-5xl font-black tabular-nums tracking-tight text-black/70 md:text-6xl">
                            <span
                              className="drop-shadow-[0_3px_0_rgba(255,255,255,.55)]"
                              style={{
                                opacity: isMovingPair ? 0 : 1,
                                transition: isMovingPair ? "none" : "opacity 120ms ease-out",
                              }}
                            >
                              {value}
                            </span>
                          </div>

                          {isSelected && (
                            <div className="absolute -bottom-2 left-1/2 h-2.5 w-2.5 -translate-x-1/2 rounded-full bg-white shadow-[0_0_0_8px_rgba(255,255,255,.55)]" />
                          )}
                        </motion.button>
                      );
                    })}
                  </div>

                  {!winner && (
                    <div className="pointer-events-none absolute -inset-8 rounded-[52px] bg-[radial-gradient(circle_at_50%_10%,rgba(255,255,255,.75),transparent_60%)]" />
                  )}

                  <AnimatePresence>
                    {moveOverlay && mergeAnim && (
                      <>
                        {/* Incoming block (slime pulls toward fusion point) */}
                        <motion.div
                          key={`${moveOverlay.id}-from`}
                          className="pointer-events-none absolute left-0 top-0 z-10 grid h-24 w-24 place-items-center rounded-3xl border-0 text-5xl font-black tabular-nums text-black/70"
                          style={{
                            background: tileStyle(moveOverlay.fromValue, targetRef.current).background,
                            borderColor: tileStyle(moveOverlay.fromValue, targetRef.current).borderColor,
                            boxShadow: tileStyle(moveOverlay.fromValue, targetRef.current).boxShadow,
                            filter: "url(#gooey)",
                          }}
                          initial={{ x: mergeAnim.fromTL.x, y: mergeAnim.fromTL.y, scaleX: 1, scaleY: 1, opacity: 1, borderRadius: "30px" }}
                          animate={{
                            x: [mergeAnim.fromTL.x, mergeAnim.fusionTL.x + mergeAnim.ux * mergeAnim.wobblePx, mergeAnim.fusionTL.x],
                            y: [mergeAnim.fromTL.y, mergeAnim.fusionTL.y + mergeAnim.uy * mergeAnim.wobblePx, mergeAnim.fusionTL.y],
                            scaleX: [1, 1.42, 0.12],
                            scaleY: [1, 0.72, 0.12],
                            rotate: [0, mergeAnim.rotateDeg, 0],
                            borderRadius: ["30px", "999px", "30px"],
                            opacity: [1, 0, 0],
                          }}
                          exit={{ opacity: 0 }}
                          transition={{
                            duration: 0.42,
                            times: [0, 0.22, 1],
                            type: "tween",
                            ease: "backInOut",
                          }}
                        >
                          <div className="absolute inset-0 rounded-3xl bg-[radial-gradient(circle_at_30%_20%,rgba(255,255,255,.95),transparent_55%)] opacity-80" />
                          <div className="relative drop-shadow-[0_3px_0_rgba(255,255,255,.55)]">{moveOverlay.fromValue}</div>
                        </motion.div>

                        {/* Merging block (victim does a tiny reverse preload before collision) */}
                        <motion.div
                          key={`${moveOverlay.id}-to`}
                          className="pointer-events-none absolute left-0 top-0 z-10 grid h-24 w-24 place-items-center rounded-3xl border-0 text-5xl font-black tabular-nums text-black/70"
                          style={{
                            background: tileStyle(moveOverlay.toValueBefore, targetRef.current).background,
                            borderColor: tileStyle(moveOverlay.toValueBefore, targetRef.current).borderColor,
                            boxShadow: tileStyle(moveOverlay.toValueBefore, targetRef.current).boxShadow,
                            filter: "url(#gooey)",
                          }}
                          initial={{ x: mergeAnim.toTL.x, y: mergeAnim.toTL.y, scaleX: 1, scaleY: 1, opacity: 1, borderRadius: "30px" }}
                          animate={{
                            x: [
                              mergeAnim.toTL.x,
                              mergeAnim.toTL.x - mergeAnim.ux * mergeAnim.prePushPx,
                              mergeAnim.fusionTL.x,
                            ],
                            y: [
                              mergeAnim.toTL.y,
                              mergeAnim.toTL.y - mergeAnim.uy * mergeAnim.prePushPx,
                              mergeAnim.fusionTL.y,
                            ],
                            scaleX: [1, 0.86, 0.12],
                            scaleY: [1, 1.12, 0.12],
                            rotate: [0, -mergeAnim.rotateDeg * 0.8, 0],
                            borderRadius: ["30px", "999px", "30px"],
                            opacity: [1, 0, 0],
                          }}
                          exit={{ opacity: 0 }}
                          transition={{
                            duration: 0.42,
                            times: [0, 0.22, 1],
                            type: "tween",
                            ease: "backInOut",
                          }}
                        >
                          <div className="absolute inset-0 rounded-3xl bg-[radial-gradient(circle_at_30%_20%,rgba(255,255,255,.95),transparent_55%)] opacity-80" />
                          <div className="relative drop-shadow-[0_3px_0_rgba(255,255,255,.55)]">{moveOverlay.toValueBefore}</div>
                        </motion.div>

                        {/* Collision splash (water-mix / slime texture) */}
                        <motion.div
                          key={`${moveOverlay.id}-splash`}
                          className="pointer-events-none absolute left-0 top-0 z-9 h-24 w-24 rounded-full"
                          style={{
                            background: `radial-gradient(circle at 50% 50%, rgba(255,255,255,.88), ${tileStyle(
                              moveOverlay.toValueAfter,
                              targetRef.current
                            ).background} 40%, rgba(255,255,255,0) 70%)`,
                            filter: "blur(2px)",
                            mixBlendMode: "screen",
                          }}
                          initial={{ x: mergeAnim.fusionTL.x, y: mergeAnim.fusionTL.y, scale: 0.12, opacity: 0 }}
                          animate={{
                            scale: [0.12, 0.12, 1.35, 0.7],
                            opacity: [0, 0.05, 0.55, 0],
                            rotate: [0, 0, 18, 0],
                          }}
                          transition={{
                            duration: 0.42,
                            times: [0, 0.68, 0.82, 1],
                            type: "tween",
                            ease: "backInOut",
                          }}
                        />

                        {/* Fusion result (pull -> squish -> ploon bounce) */}
                        <motion.div
                          key={`${moveOverlay.id}-fusion`}
                          className="pointer-events-none absolute left-0 top-0 z-10 grid h-24 w-24 place-items-center rounded-3xl border-2 text-5xl font-black tabular-nums text-black/70"
                          style={{
                            background: tileStyle(moveOverlay.toValueAfter, targetRef.current).background,
                            borderColor: tileStyle(moveOverlay.toValueAfter, targetRef.current).borderColor,
                            boxShadow: tileStyle(moveOverlay.toValueAfter, targetRef.current).boxShadow,
                          }}
                          initial={{ x: mergeAnim.fusionTL.x, y: mergeAnim.fusionTL.y, opacity: 0, scale: 1 }}
                          animate={{ x: mergeAnim.toTL.x, y: mergeAnim.toTL.y, opacity: 0.98 }}
                          transition={{ type: "spring", stiffness: 920, damping: 22, mass: 0.65, duration: 0.42 }}
                          exit={{ opacity: 0 }}
                          onAnimationComplete={finishMove}
                        >
                          <motion.div
                            className="relative h-full w-full"
                            initial={{ scale: 0.98, rotate: -6, borderRadius: "30px" }}
                            animate={{
                              // squash & stretch (liquid snap + soft settle)
                              scaleX: [0.78, 1.42, 0.96, 1.06, 1],
                              scaleY: [0.92, 0.86, 1.14, 0.98, 1],
                              rotate: [-7, 3, -2, 1, 0],
                              borderRadius: ["999px", "22px", "34px", "26px", "30px"],
                            }}
                            transition={{ duration: 0.55, ease: "easeOut" }}
                            style={{ transformOrigin: "center" }}
                          >
                            <div className="absolute inset-0 rounded-3xl bg-[radial-gradient(circle_at_30%_20%,rgba(255,255,255,.95),transparent_55%)] opacity-80" />
                            <div className="relative drop-shadow-[0_3px_0_rgba(255,255,255,.55)]">{moveOverlay.toValueAfter}</div>
                          </motion.div>
                        </motion.div>
                      </>
                    )}
                  </AnimatePresence>
                </div>
                </div>
                </div>

              </div>

              <aside className="mt-2 flex w-full max-w-[560px] flex-col items-center gap-4">
                <div className="flex w-full flex-wrap items-center justify-center gap-3 md:justify-start">
                  {!isOnlineBattle ? (
                    <>
                      <button
                        type="button"
                        onClick={() => setIsPaused(true)}
                        className="rounded-3xl border border-white/70 bg-white/80 px-5 py-4 text-sm font-black text-zinc-800 shadow-[0_16px_0_rgba(255,255,255,.72)_inset,0_18px_30px_rgba(90,60,160,.14)] transition-transform hover:brightness-105 active:scale-[0.98] md:px-4 md:py-3"
                      >
                        ポーズ
                      </button>

                      <button
                        type="button"
                        onClick={backToMenu}
                        className="rounded-3xl border border-white/70 bg-white/80 px-5 py-4 text-sm font-black text-zinc-800 shadow-[0_16px_0_rgba(255,255,255,.72)_inset,0_18px_30px_rgba(90,60,160,.14)] transition-transform hover:brightness-105 active:scale-[0.98] md:px-4 md:py-3"
                      >
                        モード選択へ
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      onClick={() => {
                        playSe("modoru");
                        surrenderOnline();
                      }}
                      className="rounded-3xl border border-white/70 bg-white/80 px-5 py-4 text-sm font-black text-zinc-800 shadow-[0_16px_0_rgba(255,255,255,.72)_inset,0_18px_30px_rgba(90,60,160,.14)] transition-transform hover:brightness-105 active:scale-[0.98] md:px-4 md:py-3"
                    >
                      降参
                    </button>
                  )}
                </div>

                {!winner && (
                  <button
                    type="button"
                    onClick={endTurnNow}
                    disabled={!canInteract || movesLeft === TURN_ACTIONS}
                    className={[
                      "whitespace-nowrap rounded-3xl border px-5 py-4 text-sm font-black shadow-[0_16px_0_rgba(255,255,255,.72)_inset,0_18px_30px_rgba(90,60,160,.14)] transition-transform md:px-4 md:py-3",
                      !canInteract || movesLeft === TURN_ACTIONS
                        ? "border-white/60 bg-white/55 text-zinc-500 opacity-75"
                        : "border-white/70 bg-white/85 text-zinc-800 hover:brightness-105 active:scale-[0.98]",
                    ].join(" ")}
                  >
                    ターン終了
                  </button>
                )}

                {matchType !== "random" ? (
                  <button
                    type="button"
                    onClick={() => reset()}
                    className="rounded-3xl border border-white/70 bg-white/80 px-5 py-4 text-sm font-black text-zinc-800 shadow-[0_16px_0_rgba(255,255,255,.72)_inset,0_18px_30px_rgba(90,60,160,.14)] transition-transform hover:brightness-105 active:scale-[0.98] md:px-4 md:py-3"
                  >
                    リセット
                  </button>
                ) : (
                  // リセット非表示（random時は隠す）。枠だけ確保して崩れを抑える。
                  <div className="h-[56px] md:h-[52px]" />
                )}
              </aside>
            </section>
          </div>
        </motion.div>
        )}
        </AnimatePresence>
      </div>

      <AnimatePresence>
        {isRuleModalOpen && (
          <motion.div
            className="fixed inset-0 z-70"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          >
            <div
              className="absolute inset-0 bg-black/40 backdrop-blur-sm"
              onClick={() => setIsRuleModalOpen(false)}
            />

            <div className="relative mx-auto flex h-full w-full max-w-2xl items-center justify-center px-4">
              <motion.div
                className="w-full rounded-3xl border border-white/70 bg-white/60 p-7 shadow-[0_34px_110px_rgba(120,70,40,.20)] backdrop-blur"
                role="dialog"
                aria-modal="true"
                aria-label="遊び方"
                initial={{ opacity: 0, scale: 0.98, y: 8 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.98, y: 8 }}
                transition={{ duration: 0.18, ease: "easeOut" }}
                onClick={(e) => e.stopPropagation()}
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="space-y-1">
                    <div className="text-xs font-black tracking-[0.25em] text-zinc-500">HOW TO PLAY</div>
                    <div className="text-2xl font-black tracking-tight text-zinc-900">遊び方（ルール）</div>
                  </div>
                  <button
                    type="button"
                    onClick={() => setIsRuleModalOpen(false)}
                    className="grid h-10 w-10 place-items-center rounded-full border border-white/70 bg-white/85 text-zinc-800 shadow-[0_14px_30px_rgba(80,60,130,.10)] transition-transform hover:brightness-105 active:scale-[0.98]"
                    aria-label="閉じる"
                  >
                    <span className="text-sm font-black">×</span>
                  </button>
                </div>

                <div className="mt-6 space-y-5 text-sm font-semibold text-zinc-700">
                  <div className="space-y-1">
                    <div className="text-base font-black text-zinc-900">🎯 勝利条件</div>
                    <div>
                      隣り合う2つのマスの数字をタップして足し合わせ、ぴったり「25」を作ったプレイヤーの勝ちです。
                    </div>
                  </div>

                  <div className="space-y-1">
                    <div className="text-base font-black text-zinc-900">⚠️ 25を超えたらどうなる？（重要）</div>
                    <div>
                      足した合計が25を超えた場合、「25で割った余り（sum % 25）」の数字に戻ってしまいます。
                    </div>
                    <div className="text-xs font-bold text-zinc-600">
                      例：15に12を足すと合計27 → マスは「2」になります。
                    </div>
                  </div>

                  <div className="space-y-1">
                    <div className="text-base font-black text-zinc-900">⚔️ 戦略のヒント</div>
                    <div>
                      わざと相手の数字をオーバーフロー（25オーバー）させて、小さな数字に戻してしまうのが勝利の鍵です。
                    </div>
                    <div className="text-xs font-bold text-zinc-600">1ターンで3回動かせます（=3アクション）。</div>
                    <div className="text-xs font-bold text-zinc-600">次に降ってくる数字（NEXT）を見ながら戦略を練りましょう。</div>
                  </div>
                </div>
              </motion.div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {helpOpen && screen === "play" && (
        <motion.div
          className="fixed inset-0 z-60"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
        >
          <div className="absolute inset-0 bg-white/60 backdrop-blur-sm" onClick={() => setHelpOpen(false)} />
          <div className="relative mx-auto flex h-full w-full max-w-2xl items-center justify-center px-4">
            <motion.div
              className="w-full rounded-[44px] border border-white/70 bg-gradient-to-b from-white/85 to-white/60 p-7 shadow-[0_34px_110px_rgba(120,70,40,.20)] backdrop-blur"
              initial={{ scale: 0.96, y: 10 }}
              animate={{ scale: 1, y: 0 }}
              exit={{ scale: 0.98, y: 10 }}
              transition={{ type: "spring", stiffness: 520, damping: 42 }}
              role="dialog"
              aria-modal="true"
              aria-label="ヘルプ"
            >
              <div className="flex items-start justify-between gap-4">
                <div>
                  <div className="text-xs font-black tracking-[0.25em] text-zinc-500">HELP</div>
                  <div className="mt-2 text-2xl font-black tracking-tight text-zinc-900">ルール & ヒント</div>
                </div>
                <button
                  type="button"
                  onClick={() => setHelpOpen(false)}
                  className="grid h-10 w-10 place-items-center rounded-full border border-white/70 bg-white/85 text-zinc-800 shadow-[0_14px_30px_rgba(80,60,130,.10)] transition-transform hover:brightness-105 active:scale-[0.98]"
                  aria-label="閉じる"
                >
                  <span className="text-sm font-black">×</span>
                </button>
              </div>

              <div className="mt-6 space-y-3 text-sm font-semibold text-zinc-700">
                <div>
                  数字は「隣接する2マス」をタップして合体します。
                </div>
                <div>
                  合体後の合計が <span className="font-black text-zinc-900">GOAL {target}</span> ぴったりなら勝利！
                </div>
                <div>
                  GOAL を超えると合体結果は <span className="font-black text-zinc-900">sum % GOAL</span> になります。
                </div>
                <div className="text-xs font-bold text-zinc-500">
                  ※ヒント表示は画面に出し過ぎないよう、必要なときだけこのヘルプで確認できます。
                </div>
              </div>
            </motion.div>
          </div>
        </motion.div>
      )}

      <AnimatePresence>
      {isPaused && screen === "play" && (
        <motion.div
          className="fixed inset-0 z-50"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
        >
          <div className="absolute inset-0 bg-white/60 backdrop-blur-sm" />
          <div className="relative mx-auto flex h-full w-full max-w-2xl items-center justify-center px-4">
            <motion.div
              className="w-full rounded-[44px] border border-white/70 bg-gradient-to-b from-white/80 to-white/55 p-7 shadow-[0_34px_110px_rgba(120,70,40,.20)] backdrop-blur"
              initial={{ scale: 0.96, y: 10 }}
              animate={{ scale: 1, y: 0 }}
              exit={{ scale: 0.98, y: 10 }}
              transition={{ type: "spring", stiffness: 520, damping: 42 }}
            >
              <div className="text-xs font-black tracking-[0.25em] text-zinc-500">PAUSE</div>
              <div className="mt-2 text-3xl font-black tracking-tight text-zinc-900">一時停止中</div>
              <div className="mt-3 text-sm font-semibold text-zinc-600">操作はロックされています。</div>

              <div className="mt-6 flex flex-wrap gap-3">
                <motion.button
                  type="button"
                  onClick={() => setIsPaused(false)}
                  className="rounded-3xl bg-gradient-to-r from-emerald-400 to-cyan-400 px-5 py-4 text-sm font-black text-white shadow-[0_18px_30px_rgba(90,60,160,.20)] transition-transform hover:brightness-105 active:scale-[0.98] md:py-3"
                  whileHover={{ y: -1 }}
                  whileTap={{ scale: 0.98 }}
                >
                  再開
                </motion.button>
                <motion.button
                  type="button"
                  onClick={() => {
                    setIsPaused(false);
                    reset();
                  }}
                  className="rounded-3xl border border-white/70 bg-white/85 px-5 py-4 text-sm font-black text-zinc-800 shadow-[0_16px_0_rgba(255,255,255,.72)_inset,0_18px_30px_rgba(90,60,160,.14)] transition-transform hover:brightness-105 active:scale-[0.98] md:py-3"
                  whileHover={{ y: -1 }}
                  whileTap={{ scale: 0.98 }}
                >
                  リセット
                </motion.button>
                {!isOnlineBattle && (
                  <motion.button
                    type="button"
                    onClick={() => {
                      setIsPaused(false);
                      backToMenu();
                    }}
                    className="rounded-3xl border border-white/70 bg-white/85 px-5 py-4 text-sm font-black text-zinc-800 shadow-[0_16px_0_rgba(255,255,255,.72)_inset,0_18px_30px_rgba(90,60,160,.14)] transition-transform hover:brightness-105 active:scale-[0.98] md:py-3"
                    whileHover={{ y: -1 }}
                    whileTap={{ scale: 0.98 }}
                  >
                    モード選択へ
                  </motion.button>
                )}
              </div>
            </motion.div>
          </div>
        </motion.div>
      )}
      </AnimatePresence>

      <AnimatePresence>
      {winner && resultModalReady && (
        <motion.div
          className="fixed inset-0 z-50"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
        >
          <div className="absolute inset-0 bg-white/60 backdrop-blur-sm" />

          <div className="pointer-events-none absolute inset-0 overflow-hidden">
            {confetti.map((c) => (
              <span
                key={c.id}
                className="confetti-piece"
                style={{
                  left: c.left,
                  width: `${c.sizePx}px`,
                  height: `${Math.max(10, c.sizePx * 2)}px`,
                  background: `hsl(${c.hue} 90% 60%)`,
                  animationDelay: `${c.delayMs}ms`,
                  animationDuration: `${c.durationMs}ms`,
                  transform: `translateY(-20px) rotate(${c.rotateDeg}deg)`,
                }}
              />
            ))}
          </div>

          <div className="relative mx-auto flex h-full w-full max-w-2xl items-center justify-center px-4">
            {showGodVictory && mode === "cpu" && cpuDifficulty === "god" && winner === 1 ? (
              <motion.div
                className="w-full rounded-[44px] border-2 border-yellow-300/80 bg-gradient-to-b from-white/85 to-white/60 p-7 shadow-[0_0_20px_goldenrod,0_34px_120px_rgba(120,70,40,.22)] backdrop-blur"
                initial={{ scale: 0.92, y: 14, rotate: -1, opacity: 0 }}
                animate={{ scale: 1, y: 0, rotate: 0, opacity: 1 }}
                exit={{ scale: 0.98, y: 10, opacity: 0 }}
                transition={{ type: "spring", stiffness: 520, damping: 22 }}
              >
                <div className="text-xs font-black tracking-[0.25em] text-amber-700/90">GOD SLAYER</div>
                <div className="mt-2 text-4xl font-black tracking-tight text-zinc-900">
                  神を超えし者、現る！
                </div>
                <div className="mt-4 flex flex-col items-center gap-3">
                  <motion.img
                    src="/images/god.png"
                    alt="エンゼル・クラウド"
                    className="select-none"
                    style={{ width: 160, height: 160, objectFit: "contain" }}
                    initial={{ scale: 0.9, y: 8, rotate: 2 }}
                    animate={{ scale: [0.95, 1.02, 1], y: [6, -2, 0], rotate: [2, -2, 0] }}
                    transition={{ type: "tween", duration: 0.6, ease: "easeInOut" }}
                    draggable={false}
                  />
                  <div className="text-center text-sm font-black text-zinc-800">
                    まさか、この私が負けるとは...！！あなたこそが真の『ぷるぷらす』マスターです！
                  </div>
                </div>

                <div className="mt-6 flex flex-wrap justify-center gap-3">
                  <motion.button
                    type="button"
                    onClick={backToMenu}
                    className="rounded-3xl bg-gradient-to-r from-amber-400 to-yellow-300 px-6 py-3 text-sm font-black text-zinc-900 shadow-[0_18px_30px_rgba(120,70,40,.22)] transition-transform hover:brightness-105 active:scale-[0.98]"
                    whileHover={{ y: -1 }}
                    whileTap={{ scale: 0.98 }}
                  >
                    モード選択へ戻る
                  </motion.button>
                </div>
              </motion.div>
            ) : (
              <motion.div
                className="w-full rounded-[44px] border border-white/70 bg-gradient-to-b from-white/80 to-white/55 p-7 shadow-[0_34px_110px_rgba(120,70,40,.20)] backdrop-blur"
                initial={{ scale: 0.96, y: 10 }}
                animate={{ scale: 1, y: 0 }}
                exit={{ scale: 0.98, y: 10 }}
                transition={{ type: "spring", stiffness: 520, damping: 42 }}
              >
                <div className="text-xs font-black tracking-[0.25em] text-zinc-500">VICTORY</div>
                <div className="mt-2 text-4xl font-black tracking-tight text-zinc-900">
                  <span className={`bg-gradient-to-r ${playerAccent(winner)} bg-clip-text text-transparent`}>
                    {playerLabel(winner)}
                  </span>{" "}
                  の勝利！
                </div>
                {victoryPraise ? (
                  <div className="mt-2 inline-flex w-fit items-center gap-2 rounded-[999px] border border-white/70 bg-white/80 px-4 py-2 text-sm font-black text-zinc-800 shadow-[0_18px_34px_rgba(90,60,160,.14)]">
                    {victoryPraise}
                  </div>
                ) : null}
                <div className="mt-3 text-sm font-semibold text-zinc-600">
                  どこかのマスが「ぴったり{target}」になりました。
                </div>
                {unlockMessage && (
                  <div className="mt-4 inline-flex items-center gap-2 rounded-[999px] border border-white/70 bg-white/80 px-4 py-2 text-sm font-black text-zinc-800 shadow-[0_18px_34px_rgba(90,60,160,.14)]">
                    <Icon name="lock" className="h-5 w-5" />
                    {unlockMessage}
                  </div>
                )}

                {matchType === "random" && resultRateChange && (
                  <div className="mt-4 w-full rounded-[20px] border border-white/70 bg-white/80 px-5 py-4 shadow-[0_18px_34px_rgba(90,60,160,.12)]">
                    <div className="text-xs font-black tracking-[0.25em] text-zinc-600">RATE CHANGE</div>
                    <div className="mt-2 flex flex-col gap-2">
                      <motion.div
                        key={resultRateNonce}
                        initial={{ opacity: 0, y: 8, scale: 0.98 }}
                        animate={{
                          opacity: 1,
                          y: 0,
                          scale: 1,
                        }}
                        transition={{ type: "spring", stiffness: 520, damping: 28 }}
                        className={[
                          "rounded-[16px] border px-4 py-3 text-sm font-black",
                          resultRateChange.yourDelta >= 0
                            ? "border-emerald-200/80 bg-emerald-50 text-emerald-900"
                            : "border-rose-200/80 bg-rose-50 text-rose-900",
                        ].join(" ")}
                      >
                        Rate: {resultRateChange.yourBefore} ➔ {resultRateChange.yourAfter} (
                        {resultRateChange.yourDelta >= 0 ? `+${resultRateChange.yourDelta}` : resultRateChange.yourDelta})
                      </motion.div>

                      <div className="rounded-[16px] border border-white/70 bg-white/70 px-4 py-3 text-sm font-black text-zinc-900">
                        Opponent: {resultRateChange.opponentBefore} ➔ {resultRateChange.opponentAfter} (
                        {resultRateChange.opponentDelta >= 0
                          ? `+${resultRateChange.opponentDelta}`
                          : resultRateChange.opponentDelta}
                        )
                      </div>
                    </div>
                  </div>
                )}

                <div className="mt-6 flex flex-wrap gap-3">
                  <motion.button
                    type="button"
                    onClick={backToMenu}
                    className="rounded-3xl bg-gradient-to-r from-emerald-400 to-cyan-400 px-5 py-3 text-sm font-black text-white shadow-[0_18px_30px_rgba(90,60,160,.20)] transition-transform hover:brightness-105 active:scale-[0.98]"
                    whileHover={{ y: -1 }}
                    whileTap={{ scale: 0.98 }}
                  >
                    モード選択へ戻る
                  </motion.button>
                </div>
              </motion.div>
            )}
          </div>
        </motion.div>
      )}
      </AnimatePresence>

      {screen === "title" && (
        <div className="fixed bottom-4 left-0 right-0 z-30 flex justify-center px-4 pointer-events-auto">
          <div className="text-center text-xs font-semibold text-zinc-600 drop-shadow">
            Sound by{" "}
            <a
              href="https://dova-s.jp/"
              target="_blank"
              rel="noreferrer"
              className="underline underline-offset-2 hover:text-zinc-900"
            >
              DOVA-SYNDROME
            </a>{" "}
            &{" "}
            <a
              href="https://otologic.jp/"
              target="_blank"
              rel="noreferrer"
              className="underline underline-offset-2 hover:text-zinc-900"
            >
              OtoLogic
            </a>
          </div>
        </div>
      )}

      <style jsx global>{`
        @keyframes tileFlash {
          0% {
            box-shadow: 0 0 0 0 rgba(249, 115, 22, 0), 0 18px 0 rgba(255, 255, 255, 0.42) inset,
              0 18px 40px rgba(80, 60, 130, 0.18), 0 2px 0 rgba(40, 30, 70, 0.16);
            filter: saturate(1) brightness(1);
          }
          25% {
            box-shadow: 0 0 0 10px rgba(249, 115, 22, 0.24), 0 18px 0 rgba(255, 255, 255, 0.48) inset,
              0 18px 40px rgba(80, 60, 130, 0.18), 0 2px 0 rgba(40, 30, 70, 0.16);
            filter: saturate(1.35) brightness(1.07);
          }
          100% {
            box-shadow: 0 0 0 0 rgba(249, 115, 22, 0), 0 18px 0 rgba(255, 255, 255, 0.42) inset,
              0 18px 40px rgba(80, 60, 130, 0.18), 0 2px 0 rgba(40, 30, 70, 0.16);
            filter: saturate(1) brightness(1);
          }
        }
        .tile-flash {
          animation: tileFlash 420ms ease-out;
        }

        @keyframes confettiFall {
          0% {
            top: -10%;
            opacity: 0;
          }
          8% {
            opacity: 1;
          }
          100% {
            top: 110%;
            opacity: 1;
          }
        }
        @keyframes confettiWiggle {
          0% {
            transform: translateY(-20px) rotate(0deg);
          }
          100% {
            transform: translateY(0) rotate(720deg);
          }
        }
        .confetti-piece {
          position: absolute;
          top: -10%;
          border-radius: 999px;
          filter: drop-shadow(0 12px 18px rgba(90, 60, 160, 0.22));
          animation-name: confettiFall, confettiWiggle;
          animation-timing-function: ease-in, linear;
          animation-iteration-count: 1, 1;
          animation-fill-mode: forwards, forwards;
        }
      `}</style>
    </main>
  );
}

