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
    
    // Determine initial phase based on customer info completeness
    // Customer info is complete only if we have name AND (email OR phone)
    const customerData = customer || {};
    const hasName = !!(customerData as any).name;
    const hasContact = !!((customerData as any).email || (customerData as any).phone);
    const customerInfoComplete = hasName && hasContact;
    const initialPhase = customerInfoComplete ? 'gathering' : 'customer_info';
    
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
    // OBSERVE: Add user message if provided and extract requirements
    if (userMessage) {
      this.state.conversationHistory.push({
        role: 'user',
        content: userMessage
      });
      
      // Extract requirements from the user's message using AI
      await this.extractRequirementsFromMessage(userMessage);
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
  }

  /**
   * Extract requirements from user message using AI first, then regex fallback
   */
  private async extractRequirementsFromMessage(message: string): Promise<void> {
    try {
      // Try AI extraction first
      await this.extractWithAI(message);
    } catch (error) {
      // Fall back to regex if AI fails
      if (this.state.phase === 'customer_info') {
        this.extractCustomerInfoWithRegex(message);
      } else {
        this.extractRequirementsWithRegex(message);
      }
    }
  }

  /**
   * Extract customer info using regex (fallback)
   */
  private extractCustomerInfoWithRegex(message: string): void {
    const msg = message.trim();
    const msgLower = msg.toLowerCase();
    
    // Check what we're currently asking for based on missing fields
    const missing = this.getMissingCustomerInfo();
    const currentField = missing[0];
    
    // Extract email first (most specific)
    const emailMatch = msg.match(/[\w.-]+@[\w.-]+\.\w+/);
    if (emailMatch && !this.state.customer.email) {
      this.state.customer.email = emailMatch[0];
      return; // Email found, don't try to extract as name/company
    }
    
    // Extract phone (check for 10+ digits)
    const digitsOnly = msg.replace(/\D/g, '');
    if (digitsOnly.length >= 10 && !this.state.customer.phone) {
      this.state.customer.phone = msg;
      return; // Phone found, don't try to extract as name/company
    }
    
    // Handle based on what field we're asking for
    if (currentField === 'name' && msg.length > 0) {
      this.state.customer.name = msg;
    } else if (currentField === 'company') {
      // Company is optional - accept empty or "skip" as valid
      if (msg.length === 0 || msgLower === 'skip' || msgLower === 'none' || msgLower === 'n/a') {
        this.state.customer.company = 'N/A'; // Mark as provided but empty
      } else {
        this.state.customer.company = msg;
      }
    } else if (currentField === 'email_or_phone' && msg.length > 0) {
      // If it looks like a phone number, save as phone, otherwise as email
      if (digitsOnly.length >= 7) {
        this.state.customer.phone = msg;
      } else {
        this.state.customer.email = msg;
      }
    }
  }

  /**
   * Extract using AI model
   */
  private async extractWithAI(message: string): Promise<void> {
    const lastQuestion = this.state.conversationHistory
      .filter(m => m.role === 'assistant')
      .slice(-1)[0]?.content || '';
    
    // Different prompts for customer info vs requirements
    const isCustomerInfo = this.state.phase === 'customer_info';
    
    // Load prompt from template and replace placeholders
    const extractionPrompt = isCustomerInfo 
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
          instructions: 'You are a data extraction assistant. Respond only with valid JSON.',
          model: this.model
        });
        const result = await run(agent, extractionPrompt);
        aiResponse = result.finalOutput || '{}';
      } else if (ollamaClient) {
        const response = await ollamaClient.chat({
          model: this.model,
          messages: [
            { role: 'system', content: 'You are a data extraction assistant. Respond only with valid JSON.' },
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
        
        // Apply extracted values based on phase
        if (this.state.phase === 'customer_info') {
          // Update customer info - only if value is truthy and not null
          if (extracted.name && extracted.name !== 'null' && !this.state.customer.name) {
            this.state.customer.name = extracted.name;
            extractedSomething = true;
          }
          if (extracted.company && extracted.company !== 'null' && !this.state.customer.company) {
            this.state.customer.company = extracted.company;
            extractedSomething = true;
          }
          if (extracted.email && extracted.email !== 'null' && !this.state.customer.email) {
            this.state.customer.email = extracted.email;
            extractedSomething = true;
          }
          if (extracted.phone && extracted.phone !== 'null' && !this.state.customer.phone) {
            this.state.customer.phone = extracted.phone;
            extractedSomething = true;
          }
          
          // If AI didn't extract anything, fall back to regex
          if (!extractedSomething) {
            this.extractCustomerInfoWithRegex(message);
          }
        } else {
          // Update requirements with extracted values
          let extractedSomethingReq = false;
          
          if (extracted.gpm && !this.state.requirements.gpm) {
            this.state.requirements.gpm = extracted.gpm;
            extractedSomethingReq = true;
          }
          if (extracted.headFt && !this.state.requirements.headFt) {
            this.state.requirements.headFt = extracted.headFt;
            extractedSomethingReq = true;
          }
          if (extracted.fluid && !this.state.requirements.fluid) {
            this.state.requirements.fluid = extracted.fluid;
            extractedSomethingReq = true;
          }
          if (extracted.powerAvailable && !this.state.requirements.powerAvailable) {
            this.state.requirements.powerAvailable = extracted.powerAvailable;
            extractedSomethingReq = true;
          }
          if (extracted.environment && !this.state.requirements.environment) {
            this.state.requirements.environment = extracted.environment;
            extractedSomethingReq = true;
          }
          if (extracted.materialPref && !this.state.requirements.materialPref) {
            this.state.requirements.materialPref = extracted.materialPref;
            extractedSomethingReq = true;
          }
          if (extracted.maintenanceBias && !this.state.requirements.maintenanceBias) {
            this.state.requirements.maintenanceBias = extracted.maintenanceBias;
            extractedSomethingReq = true;
          }
          
          // If AI didn't extract anything, fall back to regex
          if (!extractedSomethingReq) {
            this.extractRequirementsWithRegex(message);
          }
        }
      }
    } catch (error) {
      // Fallback to appropriate regex extraction based on phase
      if (this.state.phase === 'customer_info') {
        this.extractCustomerInfoWithRegex(message);
      } else {
        this.extractRequirementsWithRegex(message);
      }
    }
  }
  
  /**
   * Fallback regex-based extraction
   */
  private extractRequirementsWithRegex(message: string): void {
    const msg = message.toLowerCase();
    
    // Extract GPM
    const gpmMatch = msg.match(/(\d+)\s*(?:gpm)?/);
    if (gpmMatch && !this.state.requirements.gpm) {
      this.state.requirements.gpm = parseInt(gpmMatch[1]);
    }
    
    // Extract head
    const headMatch = msg.match(/(\d+)\s*(?:ft|feet|foot)?/);
    if (headMatch && !this.state.requirements.headFt && this.state.requirements.gpm) {
      this.state.requirements.headFt = parseInt(headMatch[1]);
    }
    
    // Extract fluid
    if (msg.includes('water')) this.state.requirements.fluid = 'water';
    else if (msg.includes('oil')) this.state.requirements.fluid = 'oil';
    else if (msg.includes('chemical')) this.state.requirements.fluid = 'chemical';
    
    // Extract power
    if (msg.match(/230v|230\s*v|single\s*phase|1\s*phase|1ph/)) {
      this.state.requirements.powerAvailable = '230V_1ph';
    } else if (msg.match(/460v|460\s*v|three\s*phase|3\s*phase|3ph/)) {
      this.state.requirements.powerAvailable = '460V_3ph';
    }
    
    // Extract environment
    if (msg.match(/atex|explosive|hazardous/)) {
      this.state.requirements.environment = 'ATEX';
    } else if (msg.match(/non-atex|non\s*atex|standard|normal/)) {
      this.state.requirements.environment = 'non-ATEX';
    }
    
    // Extract material
    if (msg.match(/stainless|steel|ss/)) {
      this.state.requirements.materialPref = 'Stainless';
    } else if (msg.match(/cast\s*iron|iron|ci/)) {
      this.state.requirements.materialPref = 'CastIron';
    } else if (msg.match(/no\s*preference|either|any|don't\s*care|doesn't\s*matter/)) {
      // Default to CastIron if no preference
      this.state.requirements.materialPref = 'CastIron';
    }
    
    // Extract maintenance
    if (msg.match(/budget|low\s*cost|cheap|economical/)) {
      this.state.requirements.maintenanceBias = 'budget';
    } else if (msg.match(/low\s*maintenance|reliable|durable|quality/)) {
      this.state.requirements.maintenanceBias = 'low maintenance';
    } else if (msg.match(/no\s*preference|either|any|don't\s*care|doesn't\s*matter/)) {
      // Default to budget if no preference
      this.state.requirements.maintenanceBias = 'budget';
    }
  }

  /**
   * THINK: Analyze current state and decide next action
   */
  private think(): string {
    const { customer, requirements, configuration, validationResult, phase } = this.state;

    // Phase 0: Collecting customer information
    if (phase === 'customer_info') {
      const missingCustomerInfo = this.getMissingCustomerInfo();
      if (missingCustomerInfo.length > 0) {
        return `ask_customer_info:${missingCustomerInfo[0]}`;
      } else {
        this.state.phase = 'gathering';
        return this.think(); // Move to next phase
      }
    }

    // Phase 1: Gathering requirements
    if (phase === 'gathering') {
      const missing = this.getMissingRequirements();
      if (missing.length > 0) {
        return `ask_requirement:${missing[0]}`;
      } else {
        this.state.phase = 'proposing';
        return 'propose_configuration';
      }
    }

    // Phase 2: Proposing configuration
    if (phase === 'proposing') {
      this.state.phase = 'validating';
      return 'validate_configuration';
    }

    // Phase 3: Validating configuration
    if (phase === 'validating') {
      if (validationResult && !validationResult.isValid) {
        return 'explain_violations';
      } else {
        this.state.phase = 'pricing';
        return 'calculate_pricing';
      }
    }

    // Phase 4: Pricing
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
    // Use AI to generate a polite, conversational question
    const context = this.state.customer.name 
      ? `The customer's name is ${this.state.customer.name}.`
      : 'This is the first interaction with the customer.';
    
    // Load prompt from template and replace placeholders
    const prompt = CUSTOMER_INFO_PROMPT_TEMPLATE
      .replace('{{FIELD}}', field)
      .replace('{{CONTEXT}}', context);

    try {
      let question = '';
      
      if (this.provider === 'openai') {
        const agent = new Agent({
          name: 'SalesAssistant',
          instructions: 'You are a friendly sales assistant. Generate polite, professional questions. Do not include thinking process or XML tags. Output only the final question.',
          model: this.model
        });
        const result = await run(agent, prompt);
        question = result.finalOutput?.trim() || this.getFallbackQuestion(field);
      } else if (ollamaClient) {
        const response = await ollamaClient.chat({
          model: this.model,
          messages: [
            { role: 'system', content: 'You are a friendly sales assistant. Generate polite, professional questions. Do not include thinking process or XML tags. Output only the final question.' },
            { role: 'user', content: prompt }
          ],
          stream: false,
        });
        question = response.message?.content?.trim() || this.getFallbackQuestion(field);
      }
      
      // Clean up any quotes that might be in the response
      question = question.replace(/^["']|["']$/g, '');
      
      this.state.conversationHistory.push({
        role: 'assistant',
        content: question
      });

      return { response: question };
    } catch (error) {
      // Fallback to predefined questions if AI fails
      const fallbackQuestion = this.getFallbackQuestion(field);
      
      this.state.conversationHistory.push({
        role: 'assistant',
        content: fallbackQuestion
      });

      return { response: fallbackQuestion };
    }
  }

  /**
   * Fallback questions if AI generation fails
   */
  private getFallbackQuestion(field: string): string {
    const questionMap: Record<string, string> = {
      'name': 'Hi! I\'m here to help you find the perfect pump. Could you share your name so I can get started?',
      'company': 'What company are you with? (Optional - press Enter to skip)',
      'email_or_phone': 'Great! Could you share your email or phone number so I can send you the quote?',
      'phone': 'What\'s your phone number?'
    };
    return questionMap[field] || `Please provide your ${field}`;
  }

  /**
   * Ask for a specific requirement using AI to generate polite questions
   */
  private async askRequirement(requirement: string): Promise<{ response: string }> {
    // Build context from already gathered requirements
    const gatheredInfo: string[] = [];
    if (this.state.customer.name) gatheredInfo.push(`Customer name: ${this.state.customer.name}`);
    if (this.state.requirements.gpm) gatheredInfo.push(`Flow rate: ${this.state.requirements.gpm} GPM`);
    if (this.state.requirements.headFt) gatheredInfo.push(`Head: ${this.state.requirements.headFt} feet`);
    if (this.state.requirements.fluid) gatheredInfo.push(`Fluid: ${this.state.requirements.fluid}`);
    
    const context = gatheredInfo.length > 0 
      ? `Information already gathered: ${gatheredInfo.join(', ')}.`
      : 'This is the first pump requirement question.';
    
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
      .replace('{{CONTEXT}}', context);

    try {
      let question = '';
      
      if (this.provider === 'openai') {
        const agent = new Agent({
          name: 'SalesAssistant',
          instructions: 'You are a friendly sales assistant. Generate polite, professional questions with VARIED phrasing. Never repeat the same sentence structure (especially "To help me..."). Do not greet the customer on every question - only on the first one. Do not include thinking process or XML tags. Output only the final question.',
          model: this.model
        });
        const result = await run(agent, prompt);
        question = result.finalOutput?.trim() || this.getFallbackRequirementQuestion(requirement);
      } else if (ollamaClient) {
        const response = await ollamaClient.chat({
          model: this.model,
          messages: [
            { role: 'system', content: 'You are a friendly sales assistant. Generate polite, professional questions with VARIED phrasing. Never repeat the same sentence structure (especially "To help me..."). Do not greet the customer on every question - only on the first one. Do not include thinking process or XML tags. Output only the final question.' },
            { role: 'user', content: prompt }
          ],
          stream: false,
        });
        question = response.message?.content?.trim() || this.getFallbackRequirementQuestion(requirement);
      }
      
      // Clean up any quotes
      question = question.replace(/^["']|["']$/g, '');
      
      this.state.conversationHistory.push({
        role: 'assistant',
        content: question
      });

      return { response: question };
    } catch (error) {
      // Fallback to predefined questions if AI fails
      const fallbackQuestion = this.getFallbackRequirementQuestion(requirement);
      
      this.state.conversationHistory.push({
        role: 'assistant',
        content: fallbackQuestion
      });

      return { response: fallbackQuestion };
    }
  }

  /**
   * Fallback requirement questions if AI generation fails
   */
  private getFallbackRequirementQuestion(requirement: string): string {
    const questionMap: Record<string, string> = {
      'gpm': 'What is the required flow rate in GPM (Gallons Per Minute)?',
      'headFt': 'What is the required head pressure in feet?',
      'fluid': 'What type of fluid will the pump handle (e.g., water, oil, chemicals)?',
      'powerAvailable': 'What power is available? (230V 1-phase or 460V 3-phase)',
      'environment': 'Will this be used in an ATEX (explosive) environment or non-ATEX?',
      'materialPref': 'Do you prefer Cast Iron or Stainless Steel material?',
      'maintenanceBias': 'Are you looking for a budget-friendly option or low maintenance?'
    };
    
    const question = questionMap[requirement] || `Please provide: ${requirement}`;
    
    // Add greeting for first question
    const isFirstQuestion = this.state.conversationHistory.filter(m => m.role === 'assistant').length === 0;
    return isFirstQuestion 
      ? `Hello! I'm here to help you find the perfect pump for your needs. ${question}`
      : question;
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

    const response = `Based on your requirements, I recommend:\n\n` +
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
    if (!this.state.customer.company) missing.push('company');
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
}

/**
 * Create a new ReAct agent
 */
export function createReActAgent(customer: CustomerInfo, provider?: 'ollama' | 'openai', workflowId?: string): ReActAgent {
  return new ReActAgent(customer, provider, workflowId);
}
