import { randomBytes } from 'node:crypto';
import { createRoom as createRoomState } from './room.js';

// Registry of rooms in memory. In Phase 1 there's no persistence beyond the
// per-game save files: on server restart, live rooms are lost but any
// unfinished games are still resumable from saved-games/ via the server lobby.
const rooms = new Map();

function newRoomId() {
  // 6 hex chars → ~16M possibilities, plenty for a self-hosted server.
  return randomBytes(3).toString('hex');
}

export function createRoom(roomName) {
  let id;
  do { id = newRoomId(); } while (rooms.has(id));
  const room = createRoomState();
  room.id = id;
  room.name = (roomName && roomName.trim()) ? roomName.trim().slice(0, 40) : `Room ${id}`;
  room.createdAt = Date.now();
  rooms.set(id, room);
  return room;
}

export function getRoom(id) {
  return id ? rooms.get(id) : undefined;
}

export function deleteRoom(id) {
  return rooms.delete(id);
}

// Wraps an already-constructed room (e.g. from a resumed save) into the
// registry. Assigns a fresh id if missing.
export function addRoom(room, roomName) {
  if (!room.id) {
    let id;
    do { id = newRoomId(); } while (rooms.has(id));
    room.id = id;
  }
  if (!room.name) {
    room.name = (roomName && roomName.trim()) ? roomName.trim().slice(0, 40) : `Room ${room.id}`;
  }
  if (!room.createdAt) room.createdAt = Date.now();
  rooms.set(room.id, room);
  return room;
}

function statusOf(room) {
  if (room.state) return room.state.status; // 'playing' | 'finished'
  return 'lobby';
}

export function summarizeRoom(room) {
  return {
    id: room.id,
    name: room.name,
    createdAt: room.createdAt,
    status: statusOf(room),
    variantId: room.options?.variantId ?? null,
    hostId: room.hostId,
    players: room.players.map((p) => ({ id: p.id, name: p.name, online: p.online })),
    turn: room.state?.turn ?? 0,
  };
}

export function listRooms() {
  const out = [];
  for (const room of rooms.values()) out.push(summarizeRoom(room));
  out.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  return out;
}

export function allRooms() {
  return Array.from(rooms.values());
}
