# nyx local setup (helios)

This fork runs fully local (no cloud AI/STT/TTS keys required for daily use).
Code changes in this repo are provider-agnostic; the actual model/voice choice
and the assistant persona live in the runtime settings file, NOT in the
committed source. This doc records what helios is configured with so the
setup can be reproduced after a reinstall or on another machine.

## Runtime settings location
`~/.config/nyx-ai-app/alice-settings.json`

A snapshot of the working config is checked into this repo at
`docs/user-config/alice-settings.helios.json` for reference/recovery.
It contains no secrets (API keys live in `.env`, which is gitignored).
To restore it: `cp docs/user-config/alice-settings.helios.json ~/.config/nyx-ai-app/alice-settings.json`
then restart nyx.

## Local model stack
- LLM: Ollama, model `qwen2.5:7b` (NOT `-coder`, the coder variant gives
  nonsensical conversational answers and ignores instructions)
- STT: whisper.cpp, `whisper-small` (ggml-small.bin, ~488MB), language `es`
  fixed. The Go backend hardcodes the filename `whisper-base.bin`, so the
  small model file is placed at that path; the original base model is kept
  alongside as `whisper-base-original.bin` in
  `resources/backend/models/` (not committed, binary assets).
- TTS: Piper, voice `en_US-amy-medium`
- Embeddings: local ONNX (intfloat/multilingual-e5-small)

## Assistant behavior
- Understands any language, always answers in English (`assistantSystemPrompt`)
- Tools enabled: get_current_datetime, open_path, execute_command,
  list_directory, manage_clipboard, perform_web_search, save_memory,
  delete_memory, recall_memories
- Can open Google Images / YouTube / web search via `open_path` with
  constructed URLs (see system prompt for the URL-building rules and Google
  `tbs=` filter reference)
- `MAX_HISTORY_MESSAGES_FOR_API`: 30 (raised from the default 10 because
  tool-calling turns consume 3-4 messages each; 10 was losing context)
- Summarizer uses the same local model (`qwen2.5:7b`), not the default
  `gpt-5.6-luna` (an invalid OpenAI model id that 404s)

## Known local-LLM quirks worked around in code
`qwen2.5:7b` via Ollama's OpenAI-compatible tool-calling occasionally emits a
plain-text claim that it performed an action ("I opened...", "I'll show
you...") without actually calling the tool. Once that false claim lands in
chat history, the model treats the action as already done and stops
retrying it on follow-up requests — even with `tool_choice=required` or low
temperature, neither of which fixed it in testing.

Fix (`src/services/llmProviders/ollama.ts`): before sending history back to
the model, any assistant message that claims an action in text but carries
no `tool_calls` gets its content replaced with an explicit correction note
("I previously said I would do this but did not actually call a tool, so
nothing happened."). This stops the false belief from propagating. The same
file also fixes a message-filtering bug that dropped assistant messages
which only carried `tool_calls` (no text content), which broke multi-turn
refinement of a previous open_path call.

## Other local fixes
- `electron/main/backendManager.ts`: added `LD_LIBRARY_PATH` pointing at the
  backend resources dir when spawning the Go backend, so bundled piper/
  whisper shared libs (libespeak-ng, libpiper_phonemize, libonnxruntime,
  libggml*, libwhisper*) are found at runtime.
- `src/utils/markdown.ts`: DOMPurify was stripping `<img>` entirely
  (not in `ALLOWED_TAGS`/`ALLOWED_ATTR`), so any image markdown in a
  response silently vanished. Added `img`/`figure`/`figcaption` and the
  `src`/`alt`/`width`/`height`/`loading`/`referrerpolicy` attributes.
- `docs/functions.json`: `open_path`/`execute_command` descriptions were
  written for Windows 11 with Windows paths. Rewritten for Arch Linux,
  home `/home/helios`, bash shell, Hyprland, Chromium as default browser.

## App shortcut
`nyx()` bash function in `~/.bashrc` launches/focuses the app (uses the
Hyprland socket directly with `hl.dsp.focus({ workspace = N })` since
`hyprctl dispatch focuswindow ...` is broken on Hyprland 0.56.2 for this
build — args containing `:` or spaces fail its Lua-based dispatch parser).

## Known gaps
- Qobuz has no official Linux client. `qobine-git` (AUR, GTK GUI, active
  fork of qobuz-player) is the intended path but its build needs sudo
  (must be run interactively, not from an automated shell) and pulls in
  rust/nodejs/webkitgtk-6.0 as build deps. Not installed yet as of this
  writing; `open_path` currently falls back to `https://play.qobuz.com`.
- `open_path` always opens a new browser tab; there's no way to make it
  replace/update the existing tab without real browser control (CDP).
