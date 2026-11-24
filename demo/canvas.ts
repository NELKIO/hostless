import { createReplica, parseRoomCode, type Hosted, type Op, type Replica } from '../src/index.js';
import { defineHostlessElements } from '../src/ui/index.js';
import { $, connectOptions, expose } from './common.js';

defineHostlessElements();

const APP = { id: 'hostless-demo-canvas', protocol: 1 };
const SIZE = 32;
const COLORS = ['#1d1d1f', '#e03131', '#f08c00', '#fab005', '#2f9e44', '#1971c2', '#7048e8', '#f8f9fa'];
type Dot = { x: number; y: number; c: number };

let replica: Hosted<Replica<Dot>> | null = null;
let color = 1;
const canvas = $('#canvas') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;

for (const [i, c] of COLORS.entries()) {
  const b = document.createElement('button');
  b.className = 'swatch';
  b.style.background = c;
  b.setAttribute('aria-label', `color ${i + 1}`);
  b.setAttribute('aria-pressed', String(i === color));
  b.addEventListener('click', () => {
    color = i;
    for (const s of $('#palette').children) s.setAttribute('aria-pressed', String(s === b));
  });
  $('#palette').append(b);
}

const valid = (op: unknown): boolean => {
  const d = op as Dot;
  return !!d && Number.isInteger(d.x) && Number.isInteger(d.y) && Number.isInteger(d.c) && d.x >= 0 && d.y >= 0 && d.x < SIZE && d.y < SIZE && d.c >= 0 && d.c < COLORS.length;
};

// the picture is a fold over ops in the shared total order: identical on every screen
const paint = (pixels: Map<number, number>, op: Op<Dot>) => pixels.set(op.op.y * SIZE + op.op.x, op.op.c);

function draw() {
  if (!replica) return;
  const pixels = replica.ordered().reduce(paint, new Map<number, number>());
  ctx.fillStyle = COLORS[7];
  ctx.fillRect(0, 0, SIZE, SIZE);
  for (const [i, c] of pixels) {
    ctx.fillStyle = COLORS[c];
    ctx.fillRect(i % SIZE, Math.floor(i / SIZE), 1, 1);
  }
  const peers = replica.room.getPeers();
  $('#info').textContent = `${replica.size} strokes · ${peers.length} other painter${peers.length === 1 ? '' : 's'}`;
  expose('__canvas', { size: replica.size, pixels: [...pixels.entries()].sort((a, b) => a[0] - b[0]), peers: peers.length });
}

function at(e: PointerEvent): Dot {
  const r = canvas.getBoundingClientRect();
  return { x: Math.min(SIZE - 1, Math.max(0, Math.floor(((e.clientX - r.left) / r.width) * SIZE))), y: Math.min(SIZE - 1, Math.max(0, Math.floor(((e.clientY - r.top) / r.height) * SIZE))), c: color };
}

let last = -1;
let down = false;
canvas.addEventListener('pointerdown', (e) => {
  down = true;
  canvas.setPointerCapture(e.pointerId);
  stroke(e);
});
canvas.addEventListener('pointermove', (e) => down && stroke(e));
canvas.addEventListener('pointerup', () => {
  down = false;
  last = -1;
});
function stroke(e: PointerEvent) {
  const d = at(e);
  const key = d.y * SIZE + d.x;
  if (key === last) return;
  last = key;
  replica?.push(d);
}

async function start(code: string) {
  $('#lobby-card').hidden = true;
  $('#paint').hidden = false;
  replica = await createReplica<Dot>({ app: APP, code, validate: valid, ...connectOptions() });
  ($('#link') as HTMLElement & { room: unknown }).room = replica.room;
  replica.on('change', draw);
  replica.room.on('peer-join', draw);
  replica.room.on('peer-leave', draw);
  expose('__paint', (x: number, y: number, c: number) => replica?.push({ x, y, c }));
  draw();
}

$('#lobby').addEventListener('hostless-room', (e) => {
  const { code } = (e as CustomEvent<{ code: string }>).detail;
  history.replaceState(null, '', `#room=${code}`);
  void start(code);
});
const fromLink = parseRoomCode(location.href);
if (fromLink && new URLSearchParams(location.search).get('autojoin') === '1') void start(fromLink);
