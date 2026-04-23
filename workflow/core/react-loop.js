/**
 * ReAct Loop - Enables dynamic tool calling for any LLM via text-based ReAct.
 * 
 * Implements Optimization Point 1: Evolve from "Static Context Injection" to "Dynamic Tool Calling".
 * Instead of injecting massive context blocks upfront, the Agent is given tools
 * (codebase_search, grep_search, read_file) to actively explore the codebase.
 */

'use strict';

class ReActLoop {
  /**
   * @param {Function} llmCall - The LLM function: async (prompt: string) => string
   * @param {Array} tools - Array of tool definitions { name, description, execute: async (args) => string }
   * @param {Object} [options]
   * @param {number} [options.maxSteps=15] - Maximum number of ReAct steps
   * @param {Function} [options.onStep] - Callback for each step
   */
  constructor(llmCall, tools, options = {}) {
    this.llmCall = llmCall;
    this.tools = tools;
    this.maxSteps = options.maxSteps || 15;
    this.onStep = options.onStep || (() => {});
  }

  /**
   * Runs the ReAct loop until the LLM produces a final answer without tool calls.
   * 
   * @param {string} initialPrompt - The initial prompt
   * @returns {Promise<string>} The final LLM response
   */
  async run(initialPrompt) {
    let currentPrompt = initialPrompt + this._buildToolInstructions();
    let step = 0;
    let finalResponse = null;

    while (step < this.maxSteps) {
      console.error(`[ReActLoop] Step ${step + 1}/${this.maxSteps}...`);
      
      const response = await this.llmCall(currentPrompt);
      const toolCalls = this._parseToolCalls(response);

      if (!toolCalls || toolCalls.length === 0) {
        console.error(`[ReActLoop] No tool calls detected. Final answer reached.`);
        finalResponse = response;
        break;
      }

      let toolResultsText = '';
      for (const call of toolCalls) {
        console.error(`[ReActLoop] 🛠️  Executing tool: ${call.name}(${JSON.stringify(call.args)})`);
        this.onStep({ step, tool: call.name, args: call.args });
        
        try {
          const tool = this.tools.find(t => t.name === call.name);
          if (!tool) {
            throw new Error(`Tool "${call.name}" not found.`);
          }
          
          const result = await tool.execute(call.args);
          const truncatedResult = this._truncateResult(result);
          toolResultsText += `\n\n<tool_result name="${call.name}">\n${truncatedResult}\n</tool_result>`;
          console.error(`[ReActLoop] ✅ Tool ${call.name} succeeded (${truncatedResult.length} chars).`);
        } catch (err) {
          toolResultsText += `\n\n<tool_result name="${call.name}">\nError: ${err.message}\n</tool_result>`;
          console.error(`[ReActLoop] ❌ Tool ${call.name} failed: ${err.message}`);
        }
      }

      currentPrompt += `\n\nAssistant:\n${response}${toolResultsText}\n\nPlease continue your analysis or provide the final output.`;
      step++;
    }

    if (!finalResponse) {
      console.warn(`[ReActLoop] ⚠️ Max steps (${this.maxSteps}) reached. Returning last response.`);
      finalResponse = await this.llmCall(currentPrompt + '\n\nSystem: Max steps reached. Please provide your final output now.');
    }

    return finalResponse;
  }

  _buildToolInstructions() {
    if (!this.tools || this.tools.length === 0) return '';

    let instructions = `\n\n## Available Tools\nYou have access to the following tools to explore the codebase dynamically. Use them to gather information before writing your final output.\n\n`;
    
    for (const tool of this.tools) {
      instructions += `### ${tool.name}\n${tool.description}\n\n`;
    }

    instructions += `## How to use tools\nTo use a tool, output a JSON block wrapped in <tool_call> tags. You can call multiple tools at once.\n`;
    instructions += `Example:\n<tool_call>\n{"name": "read_file", "args": {"path": "src/main.js"}}\n</tool_call>\n\n`;
    instructions += `The system will execute the tool and provide the result in <tool_result> tags. Once you have enough information, simply output your final Markdown document without any <tool_call> tags.\n`;

    return instructions;
  }

  _parseToolCalls(text) {
    const calls = [];
    const regex = /<tool_call>\s*(\{[\s\S]*?\})\s*<\/tool_call>/g;
    let match;

    while ((match = regex.exec(text)) !== null) {
      try {
        const parsed = JSON.parse(match[1]);
        if (parsed.name && parsed.args) {
          calls.push(parsed);
        }
      } catch (err) {
        console.warn(`[ReActLoop] Failed to parse tool call JSON: ${err.message}`);
      }
    }

    return calls;
  }

  _truncateResult(result, maxChars = 8000) {
    const str = String(result);
    if (str.length <= maxChars) return str;
    return str.slice(0, maxChars) + `\n\n... (truncated, ${str.length - maxChars} more characters)`;
  }
}

module.exports = { ReActLoop };