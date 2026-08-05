let socketInstance = null;

export function setPokerSocket(socket) {
  socketInstance = socket;
}

export function getPokerSocket() {
  if (!socketInstance) throw new Error("FBLPoker.Errors.NotReady");
  return socketInstance;
}
