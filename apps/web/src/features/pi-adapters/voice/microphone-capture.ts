import { VOICE_MAX_SAMPLES, VOICE_MAX_SECONDS, VOICE_SAMPLE_RATE } from "@ling/contracts/voice";
import { toError } from "@ling/contracts/ling-error";

export class VoiceCaptureError extends Error {
	constructor(
		readonly code:
			"unsupported" | "permission" | "missing" | "busy" | "disconnected" | "limit" | "recording" | "decode",
		cause?: unknown,
	) {
		super(`Voice capture failed: ${code}`, { cause });
	}
}

/** Browser-owned capture keeps a remote Host away from the wrong computer's microphone. */
export async function captureMicrophone(options: {
	signal: AbortSignal;
	onLevel(level: number): void;
	onLimit(): void;
	onError(error: Error): void;
}) {
	const { signal } = options;
	signal.throwIfAborted();
	if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined")
		throw new VoiceCaptureError("unsupported");
	let stream: MediaStream;
	try {
		stream = await navigator.mediaDevices.getUserMedia({
			audio: { echoCancellation: true, noiseSuppression: true },
			video: false,
		});
	} catch (cause) {
		switch (toError(cause).name) {
			case "NotAllowedError":
			case "SecurityError":
				throw new VoiceCaptureError("permission", cause);
			case "NotFoundError":
				throw new VoiceCaptureError("missing", cause);
			case "NotReadableError":
				throw new VoiceCaptureError("busy", cause);
			default:
				throw new VoiceCaptureError("recording", cause);
		}
	}
	let context: AudioContext | null = null;
	let meter: ReturnType<typeof setInterval> | undefined;
	let limit: ReturnType<typeof setTimeout> | undefined;
	let recorder: MediaRecorder | null = null;
	let disposal: Promise<void> | null = null;
	const chunks: Blob[] = [];
	const stopped = Promise.withResolvers<Blob>();
	// Device errors can arrive before the user presses Stop.
	void stopped.promise.catch(() => undefined);
	let bytes = 0;
	const onEnded = () => options.onError(new VoiceCaptureError("disconnected"));
	function dispose() {
		if (disposal) return disposal;
		signal.removeEventListener("abort", onAbort);
		clearInterval(meter);
		clearTimeout(limit);
		if (recorder?.state !== "inactive") recorder?.stop();
		for (const track of stream.getTracks()) {
			track.removeEventListener("ended", onEnded);
			track.stop();
		}
		disposal = context?.close() ?? Promise.resolve();
		return disposal;
	}
	function onAbort() {
		void dispose().catch((error: unknown) => options.onError(toError(error)));
	}
	try {
		signal.throwIfAborted();
		signal.addEventListener("abort", onAbort, { once: true });
		context = new AudioContext();
		await context.resume();
		signal.throwIfAborted();
		const source = context.createMediaStreamSource(stream);
		const analyser = context.createAnalyser();
		analyser.fftSize = 256;
		source.connect(analyser);
		const waveform = new Float32Array(analyser.fftSize);
		// Ten visual updates per second keep recording feedback responsive without transcript churn.
		meter = setInterval(() => {
			analyser.getFloatTimeDomainData(waveform);
			options.onLevel(
				Math.min(1, Math.sqrt(waveform.reduce((sum, sample) => sum + sample * sample, 0) / waveform.length) * 4),
			);
		}, 100);
		recorder = new MediaRecorder(stream);
		recorder.ondataavailable = ({ data }) => {
			bytes += data.size;
			// Compression varies by browser. This also bounds memory if its duration timer is throttled.
			if (bytes > 8 * 1024 * 1024) {
				options.onError(new VoiceCaptureError("limit"));
				return;
			}
			if (!signal.aborted) chunks.push(data);
		};
		recorder.onerror = () => {
			const error = new VoiceCaptureError("recording");
			stopped.reject(error);
			options.onError(error);
		};
		recorder.onstop = () => {
			stopped.resolve(new Blob(chunks, recorder ? { type: recorder.mimeType } : {}));
			chunks.length = 0;
		};
		for (const track of stream.getAudioTracks()) track.addEventListener("ended", onEnded, { once: true });
		recorder.start(250);
		limit = setTimeout(options.onLimit, VOICE_MAX_SECONDS * 1000);
		return {
			cancel: dispose,
			async stop(): Promise<string> {
				await dispose();
				signal.throwIfAborted();
				const blob = await stopped.promise;
				const decoder = new AudioContext();
				try {
					const audio = await decoder.decodeAudioData(await blob.arrayBuffer());
					signal.throwIfAborted();
					const frames = Math.ceil(audio.duration * VOICE_SAMPLE_RATE);
					// Encoders may add a short final packet; trim that padding at the shared duration bound.
					const length = Math.min(VOICE_MAX_SAMPLES, frames);
					if (length === 0) throw new VoiceCaptureError("decode");
					const offline = new OfflineAudioContext(1, length, VOICE_SAMPLE_RATE);
					const playback = offline.createBufferSource();
					playback.buffer = audio;
					playback.connect(offline.destination);
					playback.start();
					const samples = (await offline.startRendering()).getChannelData(0);
					signal.throwIfAborted();
					const pcm = new Uint8Array(samples.length * 2);
					const view = new DataView(pcm.buffer);
					for (let index = 0; index < samples.length; index++)
						view.setInt16(index * 2, Math.round(Math.max(-1, Math.min(1, samples[index]!)) * 32767), true);
					let binary = "";
					// Avoid spreading a two-minute recording onto the JavaScript argument stack.
					for (let offset = 0; offset < pcm.length; offset += 8192)
						binary += String.fromCharCode(...pcm.subarray(offset, offset + 8192));
					return btoa(binary);
				} catch (cause) {
					signal.throwIfAborted();
					throw new VoiceCaptureError("decode", cause);
				} finally {
					await decoder.close();
				}
			},
		};
	} catch (error) {
		await dispose();
		throw error;
	}
}

export type MicrophoneCapture = Awaited<ReturnType<typeof captureMicrophone>>;
