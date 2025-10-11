// Load environment variables
import dotenv from 'dotenv';
dotenv.config();

import { Ollama } from 'ollama';
import { Agent, run } from '@openai/agents';
import { PumpRequirements, PumpConfiguration, CustomerInfo, CPQCanvas } from '../models/types';
import { searchCatalog, validateConfiguration, calculatePricing } from './tools';
import { DataStore } from '../data/loaders';
import { parseToolCall, validateToolInput, TOOL_DEFINITIONS } from './tool-schemas';
import { ToolTraceLogger } from './tool-trace';
import * as fs from 'fs';
import * as path from 'path';

// AI Provider configuration
const AI_PROVIDER = (process.env.AI_PROVIDER || 'ollama') as 'ollama' | 'openai';

// Initialize AI clients
let ollamaClient: Ollama | null = null;

if (AI_PROVIDER !== 'openai') {
  ollamaClient = new Ollama({ 
    host: process.env.OLLAMA_HOST || 'http://localhost:11434' 
  });
}

// Load system prompt
const DEFAULT_DISCOUNT = DataStore.pricingRules.default_discount_pct;
function loadSystemPrompt(): string {
  const promptPath = path.join(__dirname, '../../data/prompts/system_prompt.xml');
  let promptContent = fs.readFileSync(promptPath, 'utf-8');
  promptContent = promptContent.replace('DYNAMIC_DISCOUNT', `${DEFAULT_DISCOUNT}%`);
  return promptContent;
}

// Load prompt templates
function loadPromptTemplate(filename: string): string {
  const promptPath = path.join(__dirname, '../../data/prompts', filename);
  const content = fs.readFileSync(promptPath, 'utf-8');
  // Extract template content from XML
  const templateMatch = content.match(/<template>([\s\S]*?)<\/template>/);
  return templateMatch ? templateMatch[1].trim() : content;
}

const SYSTEM_PROMPT = loadSystemPrompt();
const CUSTOMER_INFO_PROMPT_TEMPLATE = loadPromptTemplate('customer_info_prompt.xml');
const REQUIREMENT_QUESTION_PROMPT_TEMPLATE = loadPromptTemplate('requirement_question_prompt.xml');

// Load extraction prompts directly from file
function loadExtractionPrompts(): { customer: string; requirement: string } {
  const promptPath = path.join(__dirname, '../../data/prompts/extraction_prompt.xml');
  const content = fs.readFileSync(promptPath, 'utf-8');
  
  const customerMatch = content.match(/<customer_info_extraction>([\s\S]*?)<\/customer_info_extraction>/)?.[1];
  const customerTemplate = customerMatch?.match(/<template>([\s\S]*?)<\/template>/)?.[1].trim() || '';
  
  const requirementMatch = content.match(/<requirement_extraction>([\s\S]*?)<\/requirement_extraction>/)?.[1];
  const requirementTemplate = requirementMatch?.match(/<template>([\s\S]*?)<\/template>/)?.[1].trim() || '';
  
  return { customer: customerTemplate, requirement: requirementTemplate };
}

const EXTRACTION_PROMPTS = loadExtractionPrompts();
const EXTRACTION_PROMPT_CUSTOMER = EXTRACTION_PROMPTS.customer;
const EXTRACTION_PROMPT_REQUIREMENT = EXTRACTION_PROMPTS.requirement;

interface AgentState {
  customer: Partial<CustomerInfo>;
  requirements: Partial<PumpRequirements>;
  configuration: Partial<PumpConfiguration> | null;
  validationResult: any | null;
  pricing: any | null;
  bom: any[] | null;
  canvasPath: string | null;
  conversationHistory: Array<{ role: string; content: string }>;
  phase: 'customer_info' | 'gathering' | 'proposing' | 'validating' | 'pricing' | 'complete';
  traceLogger: ToolTraceLogger;
  retryCount: number;
}

export class ReActAgent {
  private state: AgentState;
  private model: string;
  private provider: 'ollama' | 'openai';

  constructor(customer: CustomerInfo, provider?: 'ollama' | 'openai', workflowId?: string) {
    this.provider = provider || AI_PROVIDER;
    this.model = this.provider === 'openai' 
      ? (process.env.OPENAI_MODEL || 'gpt-4o-mini')
      : (process.env.OLLAMA_MODEL || 'qwen3:8b');

    const wfId = workflowId || `react-${Date.now()}`;
    
    // Store customer data but always start with gathering pump requirements
    // Customer info will be collected at the end before generating quote
    const customerData = customer || {};
    const initialPhase = 'gathering'; // Always start with pump requirements
    
    this.state = {
      customer: customerData,
      requirements: {},
      configuration: null,
      validationResult: null,
      pricing: null,
      bom: null,
      canvasPath: null,
      conversationHistory: [
        { role: 'system', content: SYSTEM_PROMPT }
      ],
      phase: initialPhase,
      traceLogger: new ToolTraceLogger(wfId, (customerData as any).name || 'unknown'),
      retryCount: 0
    };
  }

  /**
   * Main ReAct loop - Think, Act, Observe
   */
  async step(userMessage?: string): Promise<{ response: string; done: boolean }> {
    try {
      // OBSERVE: Add user message if provided and extract requirements
      if (userMessage !== undefined) {
        this.state.conversationHistory.push({
          role: 'user',
          content: userMessage
        });
        
        // Extract requirements from the user's message using AI
        const extracted = await this.extractRequirementsFromMessage(userMessage);
        
        // If user didn't provide the required information
        if (!extracted) {
          const lastQuestion = this.state.conversationHistory
            .filter(m => m.role === 'assistant')
            .slice(-1)[0]?.content || '';
          
          const isCustomerInfo = this.state.phase === 'customer_info';
          
          // Check if this is an optional field (name or company)
          const isNameQuestion = lastQuestion.toLowerCase().includes('name') || lastQuestion.toLowerCase().includes('call you');
          const isCompanyQuestion = lastQuestion.toLowerCase().includes('company');
          const hasNoRequirements = Object.keys(this.state.requirements).length === 0;
          
          // If user skipped name at the start, move to pump questions
          if (isCustomerInfo && isNameQuestion && hasNoRequirements) {
            // User chose to skip name, continue to pump questions
            this.state.phase = 'gathering';
            // Don't add reminder to history, just continue
          } else if (isCustomerInfo && isCompanyQuestion) {
            // User skipped company (optional field), mark as skipped and continue
            this.state.customer.company = ''; // Mark as skipped with empty string
            // Don't add reminder, just continue
          } else {
            // For other missing info (required fields), ask nicely with a reminder
            const niceReminder = await this.generateMissingInfoReminder(lastQuestion, isCustomerInfo);
            
            this.state.conversationHistory.push({
              role: 'assistant',
              content: niceReminder
            });
            
            return {
              response: niceReminder,
              done: false
            };
          }
        }
      }

      // THINK: Determine what to do based on current state
      const thought = this.think();
      
      // ACT: Execute the action
      const action = await this.act(thought);
      
      // Return response and completion status
      return {
        response: action.response,
        done: this.state.phase === 'complete'
      };
    } catch (error) {
      // Handle AI extraction errors
      const errorMessage = error instanceof Error ? error.message : 'An unexpected error occurred';
      return {
        response: `❌ Error: ${errorMessage}`,
        done: false
      };
    }
  }

  /**
   * Extract requirements from user message using AI
   * Returns true if extraction was successful, false if user didn't provide info
   */
  private async extractRequirementsFromMessage(message: string): Promise<boolean> {
    return await this.extractWithAI(message);
  }

  /**
   * Extract with AI - handles both customer info and requirements
   */
  private async extractWithAI(message: string): Promise<boolean> {
    const lastQuestion = this.state.conversationHistory
      .filter(m => m.role === 'assistant')
      .slice(-1)[0]?.content || '';

    // Special handling: if message is empty and asking for company or name, treat as skip
    if (this.state.phase === 'customer_info' && (!message || message.trim() === '')) {
      const isCompanyQuestion = lastQuestion.toLowerCase().includes('company');
      const isNameQuestion = lastQuestion.toLowerCase().includes('name') || lastQuestion.toLowerCase().includes('call you');
      
      if (isCompanyQuestion) {
        // User is skipping company with empty input
        this.state.customer.company = ''; // Mark as skipped
        return true; // Treat as successful extraction (skip)
      }
      
      if (isNameQuestion && Object.keys(this.state.requirements).length === 0) {
        // User is skipping name at the start - will be asked again at the end
        return false; // Trigger the skip logic in step()
      }
    }

    // Choose extraction prompt based on phase
    const extractionPrompt = this.state.phase === 'customer_info'
      ? EXTRACTION_PROMPT_CUSTOMER
          .replace('{{QUESTION}}', lastQuestion)
          .replace('{{ANSWER}}', message)
      : EXTRACTION_PROMPT_REQUIREMENT
          .replace('{{QUESTION}}', lastQuestion)
          .replace('{{ANSWER}}', message);

    try {
      let aiResponse: string = '';
      
      if (this.provider === 'openai') {
        const agent = new Agent({
          name: 'DataExtractor',
          instructions: 'You are a data extraction assistant. Extract information and convert units to standard formats (GPM for flow, feet for head/pressure). Respond only with valid JSON.',
          model: this.model
        });
        const result = await run(agent, extractionPrompt);
        aiResponse = result.finalOutput || '{}';
      } else if (ollamaClient) {
        const response = await ollamaClient.chat({
          model: this.model,
          messages: [
            { role: 'system', content: 'You are a data extraction assistant. Extract information and convert units to standard formats (GPM for flow, feet for head/pressure). Respond only with valid JSON.' },
            { role: 'user', content: extractionPrompt }
          ],
          format: 'json',  // Force JSON output
          stream: false,
        });
        aiResponse = response.message?.content || '{}';
      }
      
      // Parse AI response - try to extract and clean JSON
      const jsonMatch = aiResponse.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        let jsonStr = jsonMatch[0];
        
        // Try to fix common JSON issues
        // Replace single quotes with double quotes
        jsonStr = jsonStr.replace(/'/g, '"');
        // Remove comments
        jsonStr = jsonStr.replace(/\/\/.*$/gm, '');
        jsonStr = jsonStr.replace(/\/\*[\s\S]*?\*\//g, '');
        
        const extracted = JSON.parse(jsonStr);
        
        // Check if AI actually extracted anything useful
        let extractedSomething = false;
        
        // Check if message indicates personal/home use - auto-skip company
        // Only check if company is not yet set and we're in a phase where we ask for customer info
        if (this.state.customer.company === undefined && 
            message.trim().length > 0 && 
            (this.state.phase === 'customer_info' || this.state.phase === 'gathering')) {
          const isPersonalUse = await this.detectPersonalUse(message);
          if (isPersonalUse) {
            this.state.customer.company = ''; // Mark as skipped for personal use
            extractedSomething = true;
          }
        }
        
        // Extract customer info (always check, regardless of phase)
        if (extracted.name && extracted.name !== 'null') {
          this.state.customer.name = extracted.name;
          extractedSomething = true;
        }
        if (extracted.company && extracted.company !== 'null') {
          this.state.customer.company = extracted.company;
          extractedSomething = true;
        }
        if (extracted.email && extracted.email !== 'null') {
          this.state.customer.email = extracted.email;
          extractedSomething = true;
        }
        if (extracted.phone && extracted.phone !== 'null') {
          this.state.customer.phone = extracted.phone;
          extractedSomething = true;
        }
        
        // Extract requirements (always check, regardless of phase)
        if (this.state.phase === 'customer_info' || this.state.phase === 'gathering') {
          // Update requirements - extract ALL values, even if multiple fields provided
          let extractedSomethingReq = false;
          
          if (extracted.gpm) {
            this.state.requirements.gpm = extracted.gpm;
            extractedSomethingReq = true;
          }
          if (extracted.headFt) {
            this.state.requirements.headFt = extracted.headFt;
            extractedSomethingReq = true;
          }
          if (extracted.fluid) {
            this.state.requirements.fluid = extracted.fluid;
            extractedSomethingReq = true;
          }
          if (extracted.powerAvailable) {
            this.state.requirements.powerAvailable = extracted.powerAvailable;
            extractedSomethingReq = true;
          }
          if (extracted.environment) {
            this.state.requirements.environment = extracted.environment;
            extractedSomethingReq = true;
          }
          if (extracted.materialPref) {
            this.state.requirements.materialPref = extracted.materialPref;
            extractedSomethingReq = true;
          }
          if (extracted.maintenanceBias) {
            this.state.requirements.maintenanceBias = extracted.maintenanceBias;
            extractedSomethingReq = true;
          }
          
          // Update overall extraction flag
          if (extractedSomethingReq) {
            extractedSomething = true;
          }
        }
        
        // Return false if user didn't provide ANY information
        if (!extractedSomething) {
          return false; // User didn't provide any info
        }
      }
      return true; // Successfully extracted information
    } catch (error) {
      // Throw error only if AI service fails, not if user didn't provide info
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      throw new Error(`AI extraction failed: ${errorMessage}. Please ensure the AI service is available.`);
    }
  }
  

  /**
   * THINK: Analyze current state and decide next action
   */
  private think(): string {
    const { customer, requirements, configuration, validationResult, phase } = this.state;

    // Phase 0: Ask for name first (if not provided and not yet asked)
    if (phase === 'gathering') {
      // Check if we should ask for name first
      const hasAskedForName = this.state.conversationHistory.some(m => 
        m.role === 'assistant' && (m.content.toLowerCase().includes('name') || m.content.toLowerCase().includes('call you'))
      );
      
      if (!customer.name && !hasAskedForName) {
        // Ask for name first, but allow skipping
        this.state.phase = 'customer_info';
        return 'ask_customer_info:name';
      }
      
      // Continue with pump requirements
      const missing = this.getMissingRequirements();
      if (missing.length > 0) {
        return `ask_requirement:${missing[0]}`;
      } else {
        // After gathering requirements, check if we need REQUIRED customer info (email/phone)
        // Name and company are optional and can be skipped
        const hasContactInfo = !!(this.state.customer.email || this.state.customer.phone);
        
        if (!hasContactInfo) {
          // Need email or phone to send quote
          this.state.phase = 'customer_info';
          return this.think(); // Move to customer info phase
        } else {
          // Have all requirements and contact info - proceed to configuration
          this.state.phase = 'proposing';
          return 'propose_configuration';
        }
      }
    }

    // Phase 2: Collecting customer information
    if (phase === 'customer_info') {
      const missingCustomerInfo = this.getMissingCustomerInfo();
      if (missingCustomerInfo.length > 0) {
        return `ask_customer_info:${missingCustomerInfo[0]}`;
      } else {
        // All customer info collected - check if we have requirements
        const missingRequirements = this.getMissingRequirements();
        
        // If we have all requirements, move to proposing
        if (missingRequirements.length === 0) {
          this.state.phase = 'proposing';
          return 'propose_configuration';
        }
        
        // If we still need requirements, go back to gathering
        this.state.phase = 'gathering';
        return this.think(); // Go back to gathering requirements
      }
    }

    // Phase 3: Proposing configuration
    if (phase === 'proposing') {
      this.state.phase = 'validating';
      return 'validate_configuration';
    }

    // Phase 4: Validating configuration
    if (phase === 'validating') {
      if (validationResult && !validationResult.isValid) {
        return 'explain_violations';
      } else {
        this.state.phase = 'pricing';
        return 'calculate_pricing';
      }
    }

    // Phase 5: Pricing
    if (phase === 'pricing') {
      this.state.phase = 'complete';
      return 'persist_canvas';
    }

    return 'done';
  }

  /**
   * ACT: Execute the decided action
   */
  private async act(thought: string): Promise<{ response: string; toolCalls?: any[] }> {
    const parts = thought.split(':');
    const action = parts[0];
    const param = parts[1];

    switch (action) {
      case 'ask_customer_info':
        return await this.askCustomerInfo(param);

      case 'ask_requirement':
        return await this.askRequirement(param);

      case 'propose_configuration':
        return await this.proposeConfiguration();

      case 'validate_configuration':
        return await this.validateConfig();

      case 'explain_violations':
        return await this.explainViolations();

      case 'calculate_pricing':
        return await this.calculatePricing();

      case 'persist_canvas':
        return await this.persistCanvas();

      case 'done':
        return { response: 'Quote generation complete!' };

      default:
        return { response: 'I need more information to proceed.' };
    }
  }

  /**
   * Ask for customer information using AI to generate polite questions
   */
  private async askCustomerInfo(field: string): Promise<{ response: string }> {
    // Build rich context from conversation history and gathered info
    const gatheredInfo: string[] = [];
    if (this.state.customer.name) gatheredInfo.push(`Name: ${this.state.customer.name}`);
    if (this.state.customer.company) gatheredInfo.push(`Company: ${this.state.customer.company}`);
    if (this.state.customer.email) gatheredInfo.push(`Email: ${this.state.customer.email}`);
    if (this.state.customer.phone) gatheredInfo.push(`Phone: ${this.state.customer.phone}`);
    
    const isFirstQuestion = this.state.conversationHistory.filter(m => m.role === 'assistant').length === 0;
    
    // Build context with customer name for personalization
    let context = '';
    if (isFirstQuestion) {
      // First question - asking for name right after welcome message
      if (field === 'name') {
        context = 'This is the first question after the welcome message. The customer has already been welcomed. DO NOT greet again. Ask for their name in an appealing, friendly, and warm way that makes them want to share. CRITICAL: Just ask the question directly - DO NOT add ANY phrases like "if you\'d rather not share", "that\'s totally fine", "no pressure", "optional", or similar. Keep it to a single simple question only. Make it sound inviting and personable.';
      } else if (this.state.customer.name) {
        context = `This is the first interaction. The customer's name is ${this.state.customer.name}. Greet them warmly using their name.`;
      } else {
        context = 'This is the first interaction with the customer.';
      }
    } else {
      context = gatheredInfo.length > 0
        ? `Information already gathered: ${gatheredInfo.join(', ')}.`
        : 'Continuing to gather customer information.';
    }
    
    // Get recent conversation for context (last 3 exchanges)
    const recentHistory = this.state.conversationHistory
      .filter(m => m.role !== 'system')
      .slice(-6)
      .map(m => `${m.role}: ${m.content}`)
      .join('\n');
    
    // Load prompt from template and replace placeholders
    const prompt = CUSTOMER_INFO_PROMPT_TEMPLATE
      .replace('{{FIELD}}', field)
      .replace('{{CONTEXT}}', context) +
      (recentHistory ? `\n\nRecent conversation:\n${recentHistory}` : '');

    let question = '';
    
    if (this.provider === 'openai') {
      const agent = new Agent({
        name: 'SalesAssistant',
        instructions: 'You are a friendly sales assistant. Generate polite, professional questions that flow naturally from the conversation. CRITICAL: VARY your phrasing dramatically - never use the same question structure twice. Be creative with how you ask. When asking for name, keep it to a single simple question - DO NOT add phrases like "if you\'d rather not share", "that\'s totally fine", "no pressure", or "optional". If the customer\'s name is provided in the context, USE IT to personalize your greeting (e.g., "Hi Sam!" or "Hello Sam,"). Use the conversation history to make your questions contextual and personalized. Do not include thinking process or XML tags. Output only the final question.',
        model: this.model
      });
      const result = await run(agent, prompt);
      question = result.finalOutput?.trim() || '';
    } else if (ollamaClient) {
      const response = await ollamaClient.chat({
        model: this.model,
        messages: [
          { role: 'system', content: 'You are a friendly sales assistant. Generate polite, professional questions that flow naturally from the conversation. CRITICAL: VARY your phrasing dramatically - never use the same question structure twice. Be creative with how you ask. When asking for name, keep it to a single simple question - DO NOT add phrases like "if you\'d rather not share", "that\'s totally fine", "no pressure", or "optional". If the customer\'s name is provided in the context, USE IT to personalize your greeting (e.g., "Hi Sam!" or "Hello Sam,"). Use the conversation history to make your questions contextual and personalized. Do not include thinking process or XML tags. Output only the final question.' },
          { role: 'user', content: prompt }
        ],
        options: {
          temperature: 0.9  // Higher temperature for more variety
        },
        stream: false,
      });
      question = response.message?.content?.trim() || '';
    } else {
      throw new Error('No AI provider configured. Please ensure OpenAI or Ollama is properly set up.');
    }
    
    if (!question) {
      throw new Error('AI failed to generate a question. Please ensure the AI service is available and responding.');
    }
    
    // Clean up any quotes that might be in the response
    question = question.replace(/^["']|["']$/g, '');
    
    this.state.conversationHistory.push({
      role: 'assistant',
      content: question
    });

    return { response: question };
  }


  /**
   * Ask for a specific requirement using AI to generate polite questions
   */
  private async askRequirement(requirement: string): Promise<{ response: string }> {
    // Build rich context from already gathered requirements
    const gatheredInfo: string[] = [];
    if (this.state.customer.name) gatheredInfo.push(`Customer: ${this.state.customer.name}`);
    if (this.state.requirements.gpm) gatheredInfo.push(`Flow rate: ${this.state.requirements.gpm} GPM`);
    if (this.state.requirements.headFt) gatheredInfo.push(`Head: ${this.state.requirements.headFt} feet`);
    if (this.state.requirements.fluid) gatheredInfo.push(`Fluid: ${this.state.requirements.fluid}`);
    if (this.state.requirements.powerAvailable) gatheredInfo.push(`Power: ${this.state.requirements.powerAvailable}`);
    if (this.state.requirements.environment) gatheredInfo.push(`Environment: ${this.state.requirements.environment}`);
    if (this.state.requirements.materialPref) gatheredInfo.push(`Material: ${this.state.requirements.materialPref}`);
    if (this.state.requirements.maintenanceBias) gatheredInfo.push(`Maintenance: ${this.state.requirements.maintenanceBias}`);
    
    const isFirstQuestion = this.state.conversationHistory.filter(m => m.role === 'assistant').length === 0;
    
    // Build context with customer name for personalization
    let context = '';
    if (isFirstQuestion) {
      // First question - don't greet again, welcome message already shown
      if (this.state.customer.name) {
        context = `This is the first pump requirement question. The customer's name is ${this.state.customer.name}. They have already been welcomed, so DO NOT greet again (no "Hi" or "Hello"). You can use their name naturally in the question if it flows well. Jump straight into asking the question professionally.`;
      } else {
        context = 'This is the first pump requirement question. The customer has already been welcomed. DO NOT greet. Jump straight into asking the question.';
      }
    } else {
      const customerName = this.state.customer.name ? `, ${this.state.customer.name}` : '';
      context = gatheredInfo.length > 0 
        ? `Customer name: ${this.state.customer.name || 'unknown'}. Information already gathered: ${gatheredInfo.join(', ')}. You can OCCASIONALLY use the customer's name in questions (not every question - maybe 1 in 3). When you do use it, place it naturally within the question, not always at the start. Add brief encouragement or positive reinforcement occasionally (e.g., "Great choice!", "Perfect!", "Excellent!").`
        : `Customer name: ${this.state.customer.name || 'unknown'}. Continuing to gather pump requirements. You can OCCASIONALLY use the customer's name in questions (not every time).`;
    }
    
    // Get recent conversation for context (last 4 exchanges)
    const recentHistory = this.state.conversationHistory
      .filter(m => m.role !== 'system')
      .slice(-8)
      .map(m => `${m.role}: ${m.content}`)
      .join('\n');
    
    // Map requirement to description for AI
    const requirementDescriptions: Record<string, string> = {
      'gpm': 'flow rate in GPM (Gallons Per Minute) - typically between 10-200 GPM',
      'headFt': 'head pressure in feet - the vertical distance the pump needs to move fluid',
      'fluid': 'type of fluid (water, oil, chemicals, etc.)',
      'powerAvailable': 'available power supply (230V 1-phase or 460V 3-phase)',
      'environment': 'environment type (ATEX/explosive or non-ATEX/standard)',
      'materialPref': 'material preference (Cast Iron for budget or Stainless Steel for corrosion resistance)',
      'maintenanceBias': 'maintenance preference (budget-friendly or low maintenance)'
    };
    
    const requirementDesc = requirementDescriptions[requirement] || requirement;
    
    // Load prompt from template and replace placeholders
    const prompt = REQUIREMENT_QUESTION_PROMPT_TEMPLATE
      .replace('{{REQUIREMENT_DESC}}', requirementDesc)
      .replace('{{CONTEXT}}', context) +
      (recentHistory ? `\n\nRecent conversation:\n${recentHistory}\n\nGenerate a natural follow-up question that flows from this conversation.` : '');

    let question = '';
    
    if (this.provider === 'openai') {
      const agent = new Agent({
        name: 'SalesAssistant',
        instructions: 'You are a friendly sales assistant having a natural conversation. Generate questions that sound like a real person talking, not a robot or form. Include practical examples and simple explanations. CRITICAL: If the context says "DO NOT greet", never use "Hi" or "Hello". Use the customer\'s name OCCASIONALLY (maybe 1 in 3 questions), not in every question. When you do use it, vary the placement - not always at the start. AVOID starting every question with the name - it becomes repetitive. Occasionally add brief encouragement like "Great!", "Perfect!", "Excellent!". Use professional phrasing - avoid contractions like "what\'s", use "what is" or "what would be". VARY your phrasing dramatically. Sound helpful and professional. Do not include thinking process or XML tags. Output only the final question.',
        model: this.model
      });
      const result = await run(agent, prompt);
      question = result.finalOutput?.trim() || '';
    } else if (ollamaClient) {
      const response = await ollamaClient.chat({
        model: this.model,
        messages: [
          { role: 'system', content: 'You are a friendly sales assistant having a natural conversation. Generate questions that sound like a real person talking, not a robot or form. Include practical examples and simple explanations. CRITICAL: If the context says "DO NOT greet", never use "Hi" or "Hello". Use the customer\'s name OCCASIONALLY (maybe 1 in 3 questions), not in every question. When you do use it, vary the placement - not always at the start. AVOID starting every question with the name - it becomes repetitive. Occasionally add brief encouragement like "Great!", "Perfect!", "Excellent!". Use professional phrasing - avoid contractions like "what\'s", use "what is" or "what would be". VARY your phrasing dramatically. Sound helpful and professional. Do not include thinking process or XML tags. Output only the final question.' },
          { role: 'user', content: prompt }
        ],
        stream: false,
      });
      question = response.message?.content?.trim() || '';
    } else {
      throw new Error('No AI provider configured. Please ensure OpenAI or Ollama is properly set up.');
    }
    
    if (!question) {
      throw new Error('AI failed to generate a question. Please ensure the AI service is available and responding.');
    }
    
    // Clean up any quotes
    question = question.replace(/^["']|["']$/g, '');
    
    this.state.conversationHistory.push({
      role: 'assistant',
      content: question
    });

    return { response: question };
  }


  /**
   * Propose a configuration using SearchCatalog tool
   */
  private async proposeConfiguration(): Promise<{ response: string; toolCalls: any[] }> {
    const { requirements } = this.state;

    // Tool Call 1: Search Catalog
    const startTime = Date.now();
    const catalogSearch = searchCatalog('family');
    this.state.traceLogger.logToolCall(
      'SearchCatalog',
      { query: 'family' },
      catalogSearch,
      Date.now() - startTime,
      true
    );
    
    // Find matching pump from flow/head map
    const flowHeadMatch = DataStore.flowHeadMap.find(item => {
      const gpmParts = item.gpmRange.split('-').map(s => parseInt(s.trim()));
      const headParts = item.headRange.split('-').map(s => parseInt(s.trim()));
      return (requirements.gpm || 0) >= gpmParts[0] && (requirements.gpm || 0) <= gpmParts[1] && 
             (requirements.headFt || 0) >= headParts[0] && (requirements.headFt || 0) <= headParts[1];
    });

    const config: PumpConfiguration = {
      family: flowHeadMatch?.family || 'P100',
      impeller: flowHeadMatch?.impellerCode || 'IMP-100-XS',
      motorHp: flowHeadMatch?.motorHp || 3,
      voltage: requirements.powerAvailable || '460V_3ph',
      sealType: requirements.maintenanceBias === 'budget' ? 'Packing' : 'Mechanical',
      material: requirements.materialPref || (requirements.environment === 'ATEX' ? 'Stainless' : 'CastIron'),
      mount: (flowHeadMatch?.motorHp || 3) <= 7.5 ? 'CloseCoupled' : 'Base',
      atex: requirements.environment === 'ATEX'
    };

    this.state.configuration = config;

    // Check if this is the first proposal (user provided all info at once)
    const questionCount = this.state.conversationHistory.filter(m => m.role === 'assistant' && m.content.includes('?')).length;
    const acknowledgment = questionCount <= 2 ? 'Perfect! I have all the information I need. ' : '';

    const response = `${acknowledgment}Based on your requirements, I recommend:\n\n` +
      `**Pump Configuration:**\n` +
      `- Family: ${config.family}\n` +
      `- Motor: ${config.motorHp} HP\n` +
      `- Voltage: ${config.voltage}\n` +
      `- Material: ${config.material}\n` +
      `- Seal: ${config.sealType}\n` +
      `- Mount: ${config.mount}\n` +
      `- ATEX: ${config.atex ? 'Yes' : 'No'}`;

    this.state.conversationHistory.push({
      role: 'assistant',
      content: response
    });

    return { 
      response,
      toolCalls: [{ tool: 'SearchCatalog', result: catalogSearch }]
    };
  }

  /**
   * Validate configuration using ValidateConstraints tool
   */
  private async validateConfig(): Promise<{ response: string; toolCalls: any[] }> {
    const startTime = Date.now();
    const validation = validateConfiguration(this.state.configuration!, this.state.requirements);
    this.state.validationResult = validation;
    
    this.state.traceLogger.logToolCall(
      'ValidateConstraints',
      { config: this.state.configuration, requirements: this.state.requirements },
      validation,
      Date.now() - startTime,
      true
    );

    const toolCalls = [{ tool: 'ValidateConstraints', result: validation }];

    if (validation.isValid) {
      return { 
        response: 'Configuration validated successfully!',
        toolCalls
      };
    } else {
      return {
        response: `Configuration has issues that need to be addressed.`,
        toolCalls
      };
    }
  }

  /**
   * Explain validation violations
   */
  private async explainViolations(): Promise<{ response: string }> {
    const violations = this.state.validationResult?.violations || [];
    
    const response = `**Configuration Issues:**\n\n` +
      violations.map((v: string) => `- ${v}`).join('\n') + '\n\n' +
      `Please let me know if you'd like me to adjust the configuration.`;

    this.state.conversationHistory.push({
      role: 'assistant',
      content: response
    });

    // For now, auto-fix and continue (in production, wait for user input)
    this.state.phase = 'pricing';
    
    return { response };
  }

  /**
   * Calculate pricing using PriceCalculator and BOMExpander tools
   */
  private async calculatePricing(): Promise<{ response: string; toolCalls: any[] }> {
    const startTime = Date.now();
    const pricing = calculatePricing(this.state.configuration as PumpConfiguration);
    this.state.pricing = pricing;
    this.state.bom = pricing.bom || [];
    
    this.state.traceLogger.logToolCall(
      'PriceCalculator',
      { config: this.state.configuration },
      pricing,
      Date.now() - startTime,
      true
    );
    
    this.state.traceLogger.logToolCall(
      'BOMExpander',
      { config: this.state.configuration },
      pricing.bom,
      0,
      true
    );

    const response = `**Pricing Summary:**\n\n` +
      `- List Price: $${pricing.listTotal.toLocaleString()}\n` +
      `- Discount: ${pricing.discountPercent}%\n` +
      `- **Net Price: $${pricing.netTotal.toLocaleString()}**\n\n` +
      `**Bill of Materials:**\n` +
      pricing.bom!.map(item => `- ${item.sku}: ${item.description} - $${item.unitPrice}`).join('\n');

    this.state.conversationHistory.push({
      role: 'assistant',
      content: response
    });

    return {
      response,
      toolCalls: [
        { tool: 'BOMExpander', result: pricing.bom },
        { tool: 'PriceCalculator', result: pricing }
      ]
    };
  }

  /**
   * Persist canvas using PersistCanvas tool
   */
  private async persistCanvas(): Promise<{ response: string; toolCalls: any[] }> {
    // Ensure customer info is complete
    const customer: CustomerInfo = {
      name: this.state.customer.name || 'Unknown',
      company: this.state.customer.company || '',
      email: this.state.customer.email,
      phone: this.state.customer.phone
    };
    
    const canvas: CPQCanvas = {
      customer,
      requirements: this.state.requirements as PumpRequirements,
      configuration: this.state.configuration as PumpConfiguration,
      rationale: this.state.validationResult?.suggestion || 'Configuration meets all requirements',
      bom: this.state.bom || [],
      pricing: this.state.pricing!,
      openQuestions: [],
      nextSteps: ['Review and approve the quote'],
      timestamp: new Date().toISOString()
    };

    // Write to file
    const startTime = Date.now();
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `quote-${timestamp}.md`;
    const RUNS_DIR = path.join(process.cwd(), 'runs');
    
    if (!fs.existsSync(RUNS_DIR)) {
      fs.mkdirSync(RUNS_DIR, { recursive: true });
    }

    const filePath = path.join(RUNS_DIR, filename);
    const markdown = this.generateMarkdown(canvas);
    fs.writeFileSync(filePath, markdown, 'utf-8');

    this.state.canvasPath = filePath;
    
    // Log PersistCanvas tool call
    this.state.traceLogger.logToolCall(
      'PersistCanvas',
      { canvas },
      { path: filePath },
      Date.now() - startTime,
      true
    );
    
    // Complete the trace with final state
    this.state.traceLogger.complete({
      customer: this.state.customer,
      requirements: this.state.requirements,
      configuration: this.state.configuration,
      pricing: this.state.pricing,
      canvasPath: filePath
    });

    const response = `✅ Quote generated successfully!\n\n` +
      `📄 Quote saved to: ${filePath}\n` +
      `📊 Trace saved to: ${this.state.traceLogger.getTracePath()}\n\n` +
      this.state.traceLogger.getSummary() + '\n\n' +
      `Thank you for using our CPQ system!`;

    this.state.conversationHistory.push({
      role: 'assistant',
      content: response
    });

    return {
      response,
      toolCalls: [{ tool: 'PersistCanvas', result: filePath }]
    };
  }

  /**
   * Get missing customer info
   */
  private getMissingCustomerInfo(): string[] {
    const missing: string[] = [];
    if (!this.state.customer.name) missing.push('name');
    // Company is optional - only add if undefined (not if empty string which means skipped)
    if (this.state.customer.company === undefined) missing.push('company');
    if (!this.state.customer.email && !this.state.customer.phone) missing.push('email_or_phone');
    return missing;
  }

  /**
   * Get missing requirements
   */
  private getMissingRequirements(): string[] {
    const required = ['gpm', 'headFt', 'fluid', 'powerAvailable', 'environment', 'materialPref', 'maintenanceBias'];
    return required.filter(key => !this.state.requirements[key as keyof PumpRequirements]);
  }

  /**
   * Generate markdown for canvas
   */
  private generateMarkdown(canvas: CPQCanvas): string {
    return `# Pump Configuration Quote

## Customer Information
- **Name:** ${canvas.customer.name}
- **Company:** ${canvas.customer.company}

## Requirements
- **Flow Rate:** ${canvas.requirements.gpm} GPM
- **Head:** ${canvas.requirements.headFt} ft
- **Fluid:** ${canvas.requirements.fluid}
- **Power:** ${canvas.requirements.powerAvailable}
- **Environment:** ${canvas.requirements.environment}

## Configuration
- **Pump Family:** ${canvas.configuration.family}
- **Motor:** ${canvas.configuration.motorHp} HP
- **Voltage:** ${canvas.configuration.voltage}
- **Material:** ${canvas.configuration.material}
- **Seal:** ${canvas.configuration.sealType}
- **Mount:** ${canvas.configuration.mount}

## Pricing
- **List Price:** $${canvas.pricing.listTotal}
- **Discount:** ${canvas.pricing.discountPercent}%
- **Net Price:** $${canvas.pricing.netTotal}

## Bill of Materials
${canvas.bom.map(item => `- ${item.sku}: ${item.description} - $${item.unitPrice}`).join('\n')}

---
*Generated: ${canvas.timestamp}*
`;
  }

  /**
   * Get current state
   */
  getState(): AgentState {
    return this.state;
  }

  /**
   * Generate a nice reminder when user doesn't provide required information
   */
  private async generateMissingInfoReminder(lastQuestion: string, isCustomerInfo: boolean): Promise<string> {
    const customerName = this.state.customer.name;
    const fieldType = isCustomerInfo ? 'contact information' : 'pump specification';
    
    const prompt = `You are PumpBot, a friendly AI-powered industrial pump specialist.

The user was asked: "${lastQuestion}"

But they didn't provide the required ${fieldType}. Generate a polite, friendly reminder that:
1. Acknowledges their response
2. Explains why this information is needed (to configure the pump properly / to send them the quote)
3. Asks them to provide the information
4. Keeps it brief and friendly (1-2 sentences)
${customerName ? `5. You can use the customer's name (${customerName}) naturally if it fits` : ''}

Examples:
- "I appreciate that, but I need the flow rate in GPM to properly size the pump for you. Could you share that information?"
- "Thanks! To configure the right pump, I'll need to know the head pressure in feet. What would that be?"
- "I understand, but to send you the quote, I'll need your email or phone number. Could you provide one of those?"

Generate ONLY the reminder message, no quotes or extra formatting.`;

    try {
      let reminder = '';
      
      if (this.provider === 'openai') {
        const agent = new Agent({
          name: 'PumpBot',
          instructions: 'You are PumpBot, a friendly AI pump specialist. Generate polite reminders when users don\'t provide required information.',
          model: this.model
        });
        const result = await run(agent, prompt);
        reminder = result.finalOutput?.trim() || '';
      } else if (ollamaClient) {
        const response = await ollamaClient.chat({
          model: this.model,
          messages: [
            { role: 'system', content: 'You are PumpBot, a friendly AI pump specialist. Generate polite reminders when users don\'t provide required information.' },
            { role: 'user', content: prompt }
          ],
          options: {
            temperature: 0.7
          },
          stream: false,
        });
        reminder = response.message?.content?.trim() || '';
      }
      
      if (!reminder) {
        // Fallback reminder
        return isCustomerInfo
          ? `I need that information to send you the quote. Could you please provide it?`
          : `I need that information to properly configure the pump for you. Could you please share it?`;
      }
      
      return reminder.replace(/^["']|["']$/g, '');
    } catch (error) {
      // Fallback on error
      return isCustomerInfo
        ? `I need that information to send you the quote. Could you please provide it?`
        : `I need that information to properly configure the pump for you. Could you please share it?`;
    }
  }

  /**
   * Generate a personalized welcome message
   */
  async generateWelcomeMessage(): Promise<string> {
    const customerName = this.state.customer.name;
    const hasName = !!customerName;
    
    const prompt = `You are PumpBot, a friendly AI-powered industrial pump specialist.

Generate a warm, welcoming, and accepting introduction message for a customer ${hasName ? `named ${customerName}` : 'who just arrived'}.

Guidelines:
- Keep it brief (2-3 sentences max)
- Introduce yourself as PumpBot in a friendly, approachable way
- Make the customer feel welcome and comfortable
- Sound warm, accepting, and genuinely helpful - not robotic or pushy
- Use natural, conversational language with a positive tone
- If customer name is provided, use it warmly
- Express genuine excitement about helping them (not over-the-top)
- Make it clear you're here to assist, not to sell

Examples:
- "Hi! I'm PumpBot, your AI-powered pump specialist. I'll help you find the perfect industrial pump for your needs. Let's get started!"
- "Hello Sarah! I'm PumpBot, and I'm here to help you find exactly the right pump for your application. I'll ask a few questions to understand your requirements."

Generate ONLY the welcome message, no quotes or extra formatting.`;

    try {
      let welcomeMessage = '';
      
      if (this.provider === 'openai') {
        const agent = new Agent({
          name: 'PumpBot',
          instructions: 'You are PumpBot, a friendly AI pump specialist. Generate warm, natural welcome messages.',
          model: this.model
        });
        const result = await run(agent, prompt);
        welcomeMessage = result.finalOutput?.trim() || '';
      } else if (ollamaClient) {
        const response = await ollamaClient.chat({
          model: this.model,
          messages: [
            { role: 'system', content: 'You are PumpBot, a friendly AI pump specialist. Generate warm, natural welcome messages.' },
            { role: 'user', content: prompt }
          ],
          stream: false,
        });
        welcomeMessage = response.message?.content?.trim() || '';
      }
      
      if (!welcomeMessage) {
        throw new Error('AI failed to generate welcome message. Please ensure the AI service is available and responding.');
      }
      
      // Clean up any quotes
      return welcomeMessage.replace(/^["']|["']$/g, '');
    } catch (error) {
      // Throw error if AI fails
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      throw new Error(`AI agent unavailable: ${errorMessage}. Please ensure the AI service is running and accessible.`);
    }
  }

  /**
   * Detect if message indicates personal/home use (to auto-skip company)
   */
  private async detectPersonalUse(message: string): Promise<boolean> {
    const prompt = `Analyze this message and determine if it indicates PERSONAL or HOME use (not business/commercial use).

Message: "${message}"

Return ONLY "true" if the message clearly indicates:
- Personal use
- Home use
- Residential use
- Private/individual use
- NOT for a company or business

Return "false" if:
- It mentions a company name
- It's for business/commercial use
- It's unclear or doesn't mention usage context

Examples:
- "I need a pump for my home" → true
- "This is for personal use" → true
- "It's for my residence" → true
- "I need this for my house" → true
- "For my backyard pool" → true
- "I need a pump for Acme Corp" → false
- "This is for our factory" → false
- "I need 50 GPM" → false (no context)

Respond with ONLY "true" or "false", nothing else.`;

    try {
      let result = '';
      
      if (this.provider === 'openai') {
        const agent = new Agent({
          name: 'PersonalUseDetector',
          instructions: 'You detect if a message indicates personal/home use. Respond only with "true" or "false".',
          model: this.model
        });
        const response = await run(agent, prompt);
        result = response.finalOutput?.trim().toLowerCase() || 'false';
      } else if (ollamaClient) {
        const response = await ollamaClient.chat({
          model: this.model,
          messages: [
            { role: 'system', content: 'You detect if a message indicates personal/home use. Respond only with "true" or "false".' },
            { role: 'user', content: prompt }
          ],
          stream: false,
        });
        result = response.message?.content?.trim().toLowerCase() || 'false';
      }
      
      return result === 'true';
    } catch (error) {
      // On error, don't auto-skip - let user decide
      return false;
    }
  }
}

/**
 * Create a new ReAct agent
 */
export function createReActAgent(customer: CustomerInfo, provider?: 'ollama' | 'openai', workflowId?: string): ReActAgent {
  return new ReActAgent(customer, provider, workflowId);
}
