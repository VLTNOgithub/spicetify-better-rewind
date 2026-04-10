// NAME: Better Rewind
// AUTHOR: vltno (based on Reeeeewwwwinnnddd by Nick Colley)
// DESCRIPTION: Hold to rewind through a track at 1x speed like you're doing a boiler room set.

(async function RewindPlugin() {
	if (!Spicetify.Player) {
		setTimeout(RewindPlugin, 1000);
		return;
	}

	const NAMESPACE = "spicetify-rewind-plugin";
	// From https://samplefocus.com/samples/vinyl-rewind
	const REWIND_AUDIO_URL = "https://raw.githubusercontent.com/VLTNOgithub/spicetify-better-rewind/main/rewind.mp3";
	const REWIND_AUDIO_INTRO = 0.5; // scratch-in start
	const REWIND_LOOP_START = 0.92; // scratch-in end / loopable body start
	const REWIND_LOOP_END = 1.25; // loopable body end / scratch-out tail start
	const REWIND_OUT_END = 3.05; // scratch-out tail end
	const REWIND_TICK_MS = 200; // how often we step backwards (milliseconds)
	const REWIND_SPEED = 5; // multiplier - ms of track per ms of real time

	function clamp(num, min, max) {
		return num <= min
			? min
			: num >= max
				? max
				: num
	}

	function addStylesToPage(styles) {
		const $style = document.createElement("style");
		$style.textContent = styles;
		document.head.appendChild($style);
	}

	function waitForElement(selector) {
		return new Promise(resolve => {
			if (document.querySelector(selector)) {
				return resolve(document.querySelector(selector));
			}
			const observer = new MutationObserver(mutations => {
				if (document.querySelector(selector)) {
					observer.disconnect();
					resolve(document.querySelector(selector));
				}
			});
			observer.observe(document.body, {
				childList: true,
				subtree: true
			});
		});
	}

	// Web Audio API for sample-accurate looping
	const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
	let audioBuffer = null;
	let activeSource = null;
	let gainNode = audioCtx.createGain();
	gainNode.connect(audioCtx.destination);

	// Scale Spotify volume (0-1) for the Web Audio gain node
	// Spotify's value is already perceptually curved, so a gentle
	// scale-down keeps the SFX at a similar level to the music
	function scaleVolume() {
		const v = Spicetify.Player.getVolume();
		return v * v * v;
	}

	// Fetch and decode the rewind sound into an AudioBuffer
	fetch(REWIND_AUDIO_URL)
		.then(res => res.arrayBuffer())
		.then(data => audioCtx.decodeAudioData(data))
		.then(buffer => { audioBuffer = buffer; })
		.catch(err => console.error('[BetterRewind] audio load failed:', err));

	function playIntroAndLoop() {
		if (!audioBuffer) return;
		stopAudioHard();
		if (audioCtx.state === 'suspended') audioCtx.resume();

		gainNode.gain.value = scaleVolume();

		const introDuration = REWIND_LOOP_START - REWIND_AUDIO_INTRO;

		// Phase 1: play the scratch-in as a one-shot
		const introSource = audioCtx.createBufferSource();
		introSource.buffer = audioBuffer;
		introSource.loop = false;
		introSource.connect(gainNode);
		introSource.start(0, REWIND_AUDIO_INTRO, introDuration);

		// Phase 2: schedule the looping body to start exactly when intro ends
		const loopSource = audioCtx.createBufferSource();
		loopSource.buffer = audioBuffer;
		loopSource.loop = true;
		loopSource.loopStart = REWIND_LOOP_START;
		loopSource.loopEnd = REWIND_LOOP_END;
		loopSource.connect(gainNode);
		loopSource.start(audioCtx.currentTime + introDuration, REWIND_LOOP_START);
		activeSource = loopSource;
	}

	function stopAudioHard() {
		if (activeSource) {
			try { activeSource.stop(); } catch (e) { }
			activeSource = null;
		}
	}

	function playTail() {
		if (!audioBuffer) return;
		if (audioCtx.state === 'suspended') audioCtx.resume();
		const tailSource = audioCtx.createBufferSource();
		tailSource.buffer = audioBuffer;
		tailSource.loop = false;
		tailSource.connect(gainNode);
		const tailDuration = REWIND_OUT_END - REWIND_LOOP_END;
		tailSource.start(0, REWIND_LOOP_END, tailDuration);
	}

	function stopAudioWithTail() {
		stopAudioHard();
		playTail();
	}

	addStylesToPage(`
        .${NAMESPACE}--playing {
          animation: ${NAMESPACE}-playing 1s linear infinite;
        }
        .${NAMESPACE}--rewind {
          animation: ${NAMESPACE}-rewind 0.5s linear infinite;
        }
        @keyframes ${NAMESPACE}-playing {
          100% {
            transform: rotate(360deg);
          }
        }
        @keyframes ${NAMESPACE}-rewind {
          from {
            transform: rotate(0deg);
          }
          to {
            transform: rotate(-360deg);
          }
        }
    `);

	// Find existing elements in the player controls UI
	const $playerControls = await waitForElement("[aria-label='Player controls']");
	const $existingBackButton = $playerControls.querySelector("button[aria-label='Previous']");

	const $button = document.createElement("button");
	$button.classList = $existingBackButton.classList;
	$button.innerHTML = $existingBackButton.innerHTML;
	$button.setAttribute("aria-label", "Rewind");

	let rewindInterval = null;
	let wasPlayingBeforeRewind = false;
	let isPlaying = null;

	function startRewind() {
		// Don't stack rewinds
		if (rewindInterval) return;

		wasPlayingBeforeRewind = Spicetify.Player.isPlaying();

		// Pause playback so the track doesn't advance while we seek backwards
		if (wasPlayingBeforeRewind) {
			Spicetify.Player.pause();
		}

		// Scale the rewind audio volume with the player volume
		playIntroAndLoop();

		$icon.classList.remove(`${NAMESPACE}--playing`);
		$icon.classList.add(`${NAMESPACE}--rewind`);

		// Seek backwards at REWIND_SPEED multiplier
		rewindInterval = window.setInterval(() => {
			const progress = Spicetify.Player.getProgress();
			const seekAmount = REWIND_TICK_MS * REWIND_SPEED;
			const newPos = Math.max(0, progress - seekAmount);
			Spicetify.Player.seek(newPos);
			// Keep sfx volume in sync with Spotify volume
			gainNode.gain.value = scaleVolume();
			// If we've hit the start, stop automatically
			if (newPos <= 0) {
				stopRewind();
			}
		}, REWIND_TICK_MS);
	}

	function stopRewind() {
		if (!rewindInterval) return;

		clearInterval(rewindInterval);
		rewindInterval = null;

		stopAudioWithTail();
		$icon.classList.remove(`${NAMESPACE}--rewind`);

		// Resume playback if it was playing before the rewind
		if (wasPlayingBeforeRewind) {
			Spicetify.Player.play();
		}
	}

	// Mouse events
	$button.addEventListener("mousedown", (e) => {
		e.preventDefault();
		startRewind();
	});
	$button.addEventListener("mouseup", () => stopRewind());
	$button.addEventListener("mouseleave", () => stopRewind());

	// Touch events for mobile / touch screens
	$button.addEventListener("touchstart", (e) => {
		e.preventDefault();
		startRewind();
	});
	$button.addEventListener("touchend", () => stopRewind());
	$button.addEventListener("touchcancel", () => stopRewind());

	// Prevent the default click so it doesn't interfere
	$button.addEventListener("click", (e) => e.preventDefault());

	const $icon = $button.querySelector("svg");
	$icon.setAttribute("viewBox", "0 0 55.33 55.33");
	// From https://www.svgrepo.com/svg/81024/vinyl-record
	$icon.innerHTML = `
      <circle cx="28.16" cy="27.67" r="3.37"/>
      <path d="M28.16 1.89a25.78 25.78 0 1 0-.99 51.55 25.78 25.78 0 0 0 .99-51.55Zm-9.83 6.4a21.63 21.63 0 0 1 10.44-2.32c.34 0 .58.85.53 1.88l-.27 5.29c-.05 1.02-.27 1.85-.48 1.84h-.4c-1.86 0-3.63.4-5.21 1.12-.94.42-2.07.17-2.6-.72l-2.7-4.57a1.79 1.79 0 0 1 .69-2.51Zm-1.06 9.72-3.98-3.5a1.73 1.73 0 0 1-.06-2.6 1.7 1.7 0 0 1 2.54.24l3.26 4.17c.64.81.78 1.77.37 2.16-.42.4-1.35.2-2.13-.47Zm1.76 9.66a9.12 9.12 0 1 1 18.25 0 9.12 9.12 0 0 1-18.25 0Zm18.9 19.38a21.62 21.62 0 0 1-10.46 2.32c-.39-.01-.66-.87-.6-1.9l.29-5.28c.05-1.03.3-1.85.55-1.84h.45c1.7 0 3.33-.33 4.82-.94.95-.4 2.12-.13 2.68.73l2.88 4.44c.56.87.32 2.01-.6 2.48Zm5.09-3.55c-.72.67-1.87.51-2.52-.28l-3.35-4.12c-.66-.79-.81-1.71-.4-2.1.4-.37 1.34-.16 2.11.52L42.85 41c.78.68.88 1.83.17 2.5Z"/>
    `;

	Spicetify.Player.addEventListener("onplaypause", () => {
		isPlaying = Spicetify.Player.isPlaying();
		$icon.classList.toggle(`${NAMESPACE}--playing`, isPlaying);
		if (isPlaying && activeSource) {
			stopAudioHard();
		}
	});

	$existingBackButton.before($button);
})();
