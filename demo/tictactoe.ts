import { createTurnMatch, inviteLink, parseHostHint, parseRoomCode, type TurnEngine, type TurnMatch, type Hosted } from '../src/index.js';
import { defineHostlessElements } from '../src/ui/index.js';
import { $, chrome, connectOptions, expose, savedRole, storageRelays } from './common.js';

chrome();
defineHostlessElements();

interface Ttt {
  board: (number | null)[];
  next: number;
  winner: number | null;
  draw: boolean;
  names: string[];
}

const LINES = [[0, 1, 2], [3, 4, 5], [6, 7, 8], [0, 3, 6], [1, 4, 7], [2, 5, 8], [0, 4, 8], [2, 4, 6]];

/** The whole game: hostless only needs these five functions. */
const ticTacToe: TurnEngine<Ttt, number, { name: string }> = {
  validateLineup: (l) => typeof (l as { name?: unknown })?.name === 'string',
  validateMove: (m) => Number.isInteger(m) && (m as number) >= 0 && (m as number) < 9,
  setup: (lineups, { seed }) => ({ board: Array(9).fill(null), next: parseInt(seed.slice(0, 2), 16) % 2, winner: null, draw: false, names: lineups.map((l) => l.name.slice(0, 20)) }),
  turn: (s) => (s.winner !== null || s.draw ? null : s.next),
  apply: (s, seat, cell) => {
    if (s.board[cell] !== null || seat !== s.next) return null;
    const board = s.board.slice();
    board[cell] = seat;
    const winner = LINES.some((l) => l.every((i) => board[i] === seat)) ? seat : null;
    return { ...s, board, next: 1 - seat, winner, draw: winner === null && board.every((c) => c !== null) };
  },
  result: (s) => (s.winner !== null ? { winner: s.winner } : s.draw ? { winner: null, draw: true } : null),
};

const APP = { id: 'hostless-demo-ttt', protocol: 1 };
const name = localStorage.getItem('demo:name') || `Player ${Math.floor(Math.random() * 900 + 100)}`;
localStorage.setItem('demo:name', name);

let match: Hosted<TurnMatch<Ttt, number, { name: string }>> | null = null;

const board = $('#board');
for (let i = 0; i < 9; i++) {
  const b = document.createElement('button');
  b.dataset.cell = String(i);
  b.setAttribute('aria-label', `cell ${i + 1}`);
  b.addEventListener('click', () => match?.move(i));
  board.append(b);
}

function winningLine(board: (number | null)[]): number[] {
  return LINES.find((l) => board[l[0]] !== null && l.every((i) => board[i] === board[l[0]])) ?? [];
}

let shown = 0;
function render() {
  if (!match) return;
  const s = match.state;
  const mine = match.mySeat;
  const marks = ['✕', '◯'];
  const win = s ? winningLine(s.board) : [];
  [...board.children].forEach((el, i) => {
    const b = el as HTMLButtonElement;
    const v = s?.board[i] ?? null;
    b.textContent = v === null ? '' : marks[v];
    b.className = v === null ? '' : v === 0 ? 'x' : 'o';
    if (win.includes(i)) b.classList.add('win');
    b.disabled = !match!.myTurn || v !== null;
  });
  // animate only the newest mark
  const count = s?.board.filter((c) => c !== null).length ?? 0;
  if (count > shown && match.history.length) {
    const last = match.history.at(-1)!.m as number;
    board.children[last]?.classList.add('pop');
  }
  shown = count;
  const phase = match.phase;
  for (const seat of [0, 1]) {
    const card = $(`#p${seat}`);
    const names = s?.names ?? [];
    card.querySelector('b')!.textContent = names[seat] ?? (seat === mine ? name : 'Waiting…');
    const peerStatus = mine === null ? '' : seat === mine ? 'you' : match.seatStatus(seat) ?? '';
    card.querySelector('small')!.textContent = peerStatus;
    card.classList.toggle('turn', phase === 'playing' && match.turn === seat);
  }
  const st = $('#status');
  st.className = 'pill';
  if (phase === 'lobby') {
    st.classList.add('wait');
    st.textContent = match.room.getPeers().length ? 'Starting…' : 'Waiting for the other player…';
  } else if (phase === 'stopped') {
    st.textContent = `Match stopped (${match.stopReason})`;
  } else if (phase === 'finished') {
    const r = match.result!;
    st.classList.add('end');
    st.textContent = r.draw ? 'Draw' : r.winner === mine ? 'You won 🎉' : 'You lost';
  } else {
    const other = match.seatStatus(1 - (mine ?? 0));
    st.classList.add(match.myTurn ? 'go' : 'wait');
    st.textContent = match.myTurn ? 'Your move' : other === 'online' ? 'Their move…' : `Their move… (opponent ${other})`;
  }
  const peer = match.room.getPeers()[0];
  $('#conn').textContent = peer ? (peer.route === 'direct' ? 'Direct WebRTC channel to the other player.' : peer.route === 'relay' ? 'Through public relays: WebRTC could not connect (or is still trying).' : 'Looking for a path…') : `Room ${match.room.code}. Nobody else here yet.`;
  $('#again').hidden = phase !== 'finished' && phase !== 'stopped';
  expose('__ttt', { phase, state: s, mySeat: mine, history: match.history.length, matchId: match.matchId, route: peer?.route ?? null, result: match.result });
}

async function start(code: string, role: 'host' | 'guest') {
  $('#lobby-card').hidden = true;
  $('#game').hidden = false;
  // guests follow only the host named in the invite link (if it names one)
  match = await createTurnMatch({ app: APP, code, role, engine: ticTacToe, meta: { name }, host: role === 'guest' ? parseHostHint(location.href) : null, mailboxRelays: storageRelays(), ...connectOptions() });
  if (role === 'host') {
    const invite = inviteLink(code, { host: match.room.peerId });
    const button = $('#invite');
    button.hidden = false;
    button.addEventListener('click', () => void navigator.clipboard?.writeText(invite).then(() => (button.textContent = 'Copied ✓')));
  }
  const link = $('#link') as HTMLElement & { room: unknown };
  link.room = match.room;
  link.hidden = false;
  match.on('change', render);
  match.room.on('peer-join', render);
  match.room.on('route', render);
  match.on('result', () => match!.settle());
  if (match.phase === 'lobby') match.ready({ name });
  render();
}

$('#leave').addEventListener('click', async () => {
  await match?.close();
  location.href = location.pathname;
});
$('#again').addEventListener('click', () => {
  location.href = location.pathname;
});

const lobby = $('#lobby');
lobby.addEventListener('hostless-room', (e) => {
  const { code, role } = (e as CustomEvent<{ code: string; role: 'host' | 'guest' }>).detail;
  history.replaceState(null, '', `#room=${code}`);
  void start(code, savedRole(APP.id, code) ?? role);
});
const params = new URLSearchParams(location.search);
const fromLink = parseRoomCode(location.href);
const forced = params.get('role') === 'host' ? 'host' : params.get('autojoin') === '1' ? 'guest' : null;
if (fromLink && (savedRole(APP.id, fromLink) || forced)) void start(fromLink, savedRole(APP.id, fromLink) ?? forced!);
