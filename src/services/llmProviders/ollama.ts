import type OpenAI from 'openai'
import { useSettingsStore } from '../../stores/settingsStore'
import { getOllamaClient } from '../apiClients'
import { convertLocalLLMStreamToResponsesFormat } from './streamAdapters'
import { buildToolsForProvider } from './tools'

export const listOllamaModels = async (): Promise<OpenAI.Models.Model[]> => {
  const client = getOllamaClient()
  const modelsPage = await client.models.list()
  return modelsPage.data.sort((a, b) => a.id.localeCompare(b.id))
}

export const createOllamaResponse = async (
  input: OpenAI.Responses.Request.InputItemLike[],
  _previousResponseId: string | null,
  stream: boolean = false,
  customInstructions?: string,
  signal?: AbortSignal
): Promise<any> => {
  const client = getOllamaClient()
  const settings = useSettingsStore().config
  const finalToolsForApi = await buildToolsForProvider()

  const messages = input
    .map((item: any) => {
      if (item.role === 'user') {
        if (Array.isArray(item.content)) {
          const textParts = item.content
            .filter(
              (part: any) => part.type === 'input_text' && part.text?.trim()
            )
            .map((part: any) => part.text)
            .join(' ')

          return {
            role: 'user',
            content: textParts || 'Hello',
          }
        } else if (typeof item.content === 'string' && item.content.trim()) {
          return {
            role: 'user',
            content: item.content,
          }
        } else {
          return {
            role: 'user',
            content: 'Hello',
          }
        }
      } else if (item.role === 'assistant') {
        const textContent = Array.isArray(item.content)
          ? item.content
              .filter(
                (part: any) => part.type === 'output_text' && part.text?.trim()
              )
              .map((part: any) => part.text)
              .join(' ')
          : typeof item.content === 'string' && item.content.trim()
            ? item.content
            : null

        const toolCalls = item.tool_calls || null

        const localLLMToolCalls = toolCalls
          ? toolCalls.map((toolCall: any) => ({
              id: toolCall.call_id || toolCall.id,
              type: 'function',
              function: {
                name: toolCall.name,
                arguments:
                  typeof toolCall.arguments === 'string'
                    ? toolCall.arguments
                    : JSON.stringify(toolCall.arguments || {}),
              },
            }))
          : null

        return {
          role: 'assistant',
          content: textContent ?? '',
          tool_calls: localLLMToolCalls,
        }
      } else if (item.role === 'system') {
        const content =
          typeof item.content === 'string'
            ? item.content
            : Array.isArray(item.content)
              ? item.content.map((p: any) => p.text || '').join(' ')
              : 'You are a helpful assistant.'

        return {
          role: 'system',
          content: content.trim() || 'You are a helpful assistant.',
        }
      } else if (item.type === 'function_call_output') {
        return {
          role: 'tool',
          tool_call_id: item.call_id,
          content:
            typeof item.output === 'string'
              ? item.output
              : JSON.stringify(item.output),
        }
      }

      return {
        ...item,
        content:
          typeof item.content === 'string' && item.content.trim()
            ? item.content
            : 'Message received.',
      }
    })
    .filter(msg => {
      // Keep assistant messages that carry tool_calls even when they have no
      // text content, otherwise the model loses track of what it already did
      // (e.g. which URL it opened) and cannot refine a previous action.
      if (msg.role === 'assistant' && msg.tool_calls?.length) return true
      return msg.content?.trim && msg.content.trim()
    })
    .map(msg => {
      // Guard against a recurring local-LLM failure mode: the assistant
      // claims in plain text that it performed an action ("I opened...",
      // "I'll show you...") without emitting a tool_call. If that false
      // claim survives in history, the model treats the action as already
      // done and never retries it on a follow-up request. Strip the claim
      // so it can't poison future turns; the corresponding tool_calls (if
      // any) are preserved separately.
      if (
        msg.role === 'assistant' &&
        !msg.tool_calls?.length &&
        typeof msg.content === 'string' &&
        (/\b(I('| ha)ve|I'll|I will|I just|I've)\b.{0,40}\b(open|search|show|look up|find|display|navigat|launch|start|run|execut)/i.test(
          msg.content
        ) ||
          /https?:\/\//i.test(msg.content))
      ) {
        return {
          ...msg,
          content:
            "(Note: I previously said I would do this but did not actually call a tool, so nothing happened.)",
        }
      }
      return msg
    })

  if (customInstructions && !messages.some(msg => msg.role === 'system')) {
    messages.unshift({
      role: 'system',
      content: customInstructions,
    })
  }

  console.log('[ollama] Final messages:', JSON.stringify(messages, null, 2))

  const params: OpenAI.Chat.ChatCompletionCreateParams = {
    model: settings.assistantModel || 'llama3.2',
    messages: messages,
    temperature: settings.assistantTemperature,
    top_p: settings.assistantTopP,
    tools:
      finalToolsForApi.length > 0
        ? finalToolsForApi.map(tool => {
            if (tool.type === 'function') {
              return {
                type: 'function',
                function: {
                  name: tool.name,
                  description: tool.description,
                  parameters: tool.parameters,
                },
              }
            }
            return tool
          })
        : undefined,
    stream: stream,
  }

  if (stream) {
    const localStream = await client.chat.completions.create(params as any, {
      signal,
    })
    return convertLocalLLMStreamToResponsesFormat(localStream, 'ollama')
  }

  return client.chat.completions.create(params as any, { signal })
}
