#!/usr/bin/env node
// Load environment variables first
import dotenv from 'dotenv';
dotenv.config();

import { Connection, WorkflowClient } from '@temporalio/client';
import { quoteWorkflow } from '../workflows/quote.workflow';
import { nanoid } from 'nanoid';
import inquirer from 'inquirer';
import chalk from 'chalk';
import { createReActAgent } from '../agent/react-agent';
import { CustomerInfo } from '../models/types';
import { Command } from 'commander';

// Initialize Temporal client
async function getClient() {
  const connection = await Connection.connect({
    address: process.env.TEMPORAL_ADDRESS || 'localhost:7233',
  });
  return new WorkflowClient({
    connection,
  });
}

// Main function to start the interactive quote process with ReAct agent + Temporal
async function startInteractiveQuote(companyName?: string, contactName?: string) {
  const provider = process.env.AI_PROVIDER || 'ollama';
  const model = provider === 'openai' 
    ? (process.env.OPENAI_MODEL || 'gpt-4o-mini')
    : (process.env.OLLAMA_MODEL || 'qwen3:8b');
  
  console.log(chalk.blue(`\n=== Industrial Pump CPQ Agent (ReAct + Temporal - ${provider.toUpperCase()}: ${model}) ===\n`));
  
  // Initialize ReAct agent (will handle both customer info AND requirements)
  console.log(chalk.blue('Initializing AI agent...'));
  
  // Pre-fill customer info if provided via CLI args
  const initialCustomer: Partial<CustomerInfo> = {};
  if (companyName) initialCustomer.company = companyName;
  if (contactName) initialCustomer.name = contactName;
  
  const agent = createReActAgent(initialCustomer as CustomerInfo, provider as 'ollama' | 'openai');
  
  console.log(chalk.green('✓ Agent ready!\n'));
  console.log(chalk.yellow('The agent will ask questions to understand your pump requirements.\n'));
  
  // ReAct Loop: Gather customer info and requirements (stop when proposing configuration)
  let gatheringComplete = false;
  
  // First step - agent asks first question
  let result = await agent.step();
  console.log(chalk.cyan('Agent:'), result.response, '\n');
  
  while (!gatheringComplete) {
    // Check if we're asking for optional field (company)
    const agentState = agent.getState();
    const missingInfo = agentState.phase === 'customer_info' 
      ? (!agentState.customer.name ? 'name' : !agentState.customer.company ? 'company' : 'email_or_phone')
      : null;
    const isOptionalField = missingInfo === 'company';
    
    // Get user input
    const { userInput } = await inquirer.prompt([{
      type: 'input',
      name: 'userInput',
      message: 'You:',
      validate: (input: string) => {
        // Allow empty input for optional fields
        if (isOptionalField) return true;
        return input.trim() !== '' || 'Please enter a response';
      }
    }]);
    
    // Agent processes input and decides next action
    result = await agent.step(userInput);
    console.log(chalk.cyan('\nAgent:'), result.response, '\n');
    
    // Check if we've finished gathering (moved past 'gathering' phase to 'proposing')
    const updatedState = agent.getState();
    if (updatedState.phase !== 'customer_info' && updatedState.phase !== 'gathering') {
      gatheringComplete = true;
    }
  }
  
  // Get gathered requirements and customer info from agent
  const agentState = agent.getState();
  const requirements = agentState.requirements;
  const customerInfo: CustomerInfo = {
    name: agentState.customer.name || 'Unknown',
    company: agentState.customer.company || '',
    email: agentState.customer.email,
    phone: agentState.customer.phone
  };
  
  console.log(chalk.blue('\n=== Information Gathered ==='));
  console.log('Customer:', JSON.stringify(customerInfo, null, 2));
  console.log('Requirements:', JSON.stringify(requirements, null, 2));
  
  // Phase 2: Launch Temporal workflow for configuration, validation, pricing, and persistence
  console.log(chalk.blue('\n🚀 Launching Temporal workflow...'));
  
  try {
    const client = await getClient();
    const workflowId = `cpq-quote-${nanoid()}`;
    
    const handle = await client.start(quoteWorkflow, {
      taskQueue: 'cpq-queue',
      workflowId,
      args: [{
        customer: customerInfo,
        initialRequirements: requirements
      }]
    });
    
    console.log(chalk.blue(`Workflow started: ${workflowId}`));
    console.log(chalk.yellow('Processing configuration, validation, pricing, and saving quote...\n'));
    
    // Wait for workflow to complete
    const canvas = await handle.result();
    
    console.log(chalk.green('\n✓ Quote generated successfully!'));
    console.log(chalk.blue('\n=== Quote Summary ==='));
    console.log(`Customer: ${canvas.customer.name} (${canvas.customer.company})`);
    console.log(`Pump: ${canvas.configuration.family} - ${canvas.configuration.motorHp}HP`);
    console.log(`Configuration: ${canvas.configuration.sealType} seal, ${canvas.configuration.material} material, ${canvas.configuration.mount} mount`);
    console.log(`Total Price: $${canvas.pricing.netTotal.toFixed(2)} (${canvas.pricing.discountPercent}% discount applied)`);
    console.log(`\nRationale: ${canvas.rationale}`);
    
    // Show BOM summary
    console.log(chalk.blue('\n=== Bill of Materials ==='));
    canvas.bom.forEach(item => {
      console.log(`${item.quantity}x ${item.sku} - ${item.description}: $${item.extendedPrice.toFixed(2)}`);
    });
    
    console.log(chalk.blue(`\nList Total: $${canvas.pricing.listTotal.toFixed(2)}`));
    console.log(chalk.green(`Net Total: $${canvas.pricing.netTotal.toFixed(2)}`));
    
    // Show canvas file path
    console.log(chalk.blue('\n=== Quote Files Generated ==='));
    console.log(chalk.green(`✓ Quote saved to: ./runs/ directory`));
    console.log(chalk.blue('Check the ./runs/ directory for JSON and Markdown files.'));
    
  } catch (error) {
    console.error(chalk.red('\nError generating quote:'), error);
    console.log(chalk.yellow('\nMake sure:'));
    console.log('1. Temporal server is running (npm run temporal)');
    console.log('2. Worker is running (npm run worker)');
  }
  
  process.exit(0);
}

// Helper function to collect customer information with agent-style questions
async function collectCustomerInfoWithAgent(companyName?: string, contactName?: string): Promise<CustomerInfo> {
  const customer: Partial<CustomerInfo> = {};
  
  // Question 1: Name (mandatory)
  if (contactName) {
    customer.name = contactName;
    console.log(chalk.cyan('Agent:'), `Hello ${contactName}! I'm here to help you configure the perfect pump.`);
  } else {
    console.log(chalk.cyan('Agent:'), 'Hello! I\'m here to help you configure the perfect pump. What is your name?');
    const { name } = await inquirer.prompt([{
      type: 'input',
      name: 'name',
      message: 'You:',
      validate: (input: string) => input.trim() !== '' || 'Name is required'
    }]);
    customer.name = name;
  }
  
  // Question 2: Company (optional)
  if (companyName) {
    customer.company = companyName;
    console.log(chalk.cyan('\nAgent:'), `Great! I see you're with ${companyName}.`);
  } else {
    console.log(chalk.cyan('\nAgent:'), 'What company are you with? (optional, press Enter to skip)');
    const { company } = await inquirer.prompt([{
      type: 'input',
      name: 'company',
      message: 'You:',
    }]);
    if (company.trim()) customer.company = company;
  }
  
  // Question 3: Email or Phone (at least one required)
  console.log(chalk.cyan('\nAgent:'), 'I\'ll need either your email or phone number to send you the quote. What\'s your email address?');
  const { email } = await inquirer.prompt([{
    type: 'input',
    name: 'email',
    message: 'You:',
  }]);
  
  if (email.trim()) {
    customer.email = email;
  } else {
    // If no email, phone is required
    console.log(chalk.cyan('\nAgent:'), 'No problem. What\'s your phone number?');
    const { phone } = await inquirer.prompt([{
      type: 'input',
      name: 'phone',
      message: 'You:',
      validate: (input: string) => input.trim() !== '' || 'Either email or phone is required'
    }]);
    customer.phone = phone;
  }
  
  // Optional: Ask for phone if email was provided
  if (customer.email && !customer.phone) {
    console.log(chalk.cyan('\nAgent:'), 'Would you also like to provide a phone number? (optional, press Enter to skip)');
    const { phone } = await inquirer.prompt([{
      type: 'input',
      name: 'phone',
      message: 'You:',
    }]);
    if (phone.trim()) customer.phone = phone;
  }
  
  console.log(chalk.green('\n✓ Great! I have your contact information.\n'));
  
  return customer as CustomerInfo;
}

// CLI setup
const program = new Command();

program
  .name('cpq-agent')
  .description('Industrial Pump CPQ Agent with Temporal Workflow')
  .version('1.0.0')
  .option('--customer <company>', 'Company name (e.g., "Acme Co")')
  .option('--contact <name>', 'Contact person name (e.g., "Sam")')
  .action(async (options) => {
    await startInteractiveQuote(options.customer, options.contact);
  });

program.parse();
