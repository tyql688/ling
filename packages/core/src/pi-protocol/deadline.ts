export function schedulePiWorkerDeadline(deadlineAt: number, callback: () => void): () => void {
	const timer = setTimeout(callback, Math.max(0, deadlineAt - Date.now()));
	timer.unref();
	return () => clearTimeout(timer);
}
