# Nyx

Local AI assistant — part of the Hermes pantheon.

Nyx is a desktop AI assistant built on top of [Alice](https://github.com/pmbstyle/Alice) (MIT).
It runs entirely on local models via Ollama, with persistent memory across sessions.

## Stack

- Electron + Vue 3 + TypeScript (frontend)
- Go backend (embeddings, local STT/TTS)
- Ollama (local LLM inference)
- SQLite + HNSWlib (memory: long-term + vector)

## Target hardware

Acer Helios 300 — i7-12700H, RTX 3060 (6GB VRAM), 16GB RAM
Recommended model: `qwen2.5:7b`

## Setup (development)

```bash
# 1. Install Ollama and pull a model
ollama pull qwen2.5:7b
ollama pull nomic-embed-text   # for embeddings

# 2. Clone and install
git clone https://github.com/santiago-giordano/alice.git nyx
cd nyx
npm install

# 3. Set up local embeddings model
npm run setup:embeddings

# 4. Build Go backend
npm run build:go

# 5. Run
npm run dev
```

## Configuration

In Settings → Core → AI Provider: select **Ollama**, set base URL to `http://localhost:11434`.
No API keys required for local use.

## Credits

Forked from [pmbstyle/Alice](https://github.com/pmbstyle/Alice) — MIT License.
