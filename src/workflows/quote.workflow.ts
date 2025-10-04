import { proxyActivities, defineSignal, setHandler, condition } from '@temporalio/workflow';
import type * as activities from '../activities/quote.activities';
import { 
  CustomerInfo, 
  PumpRequirements, 
  PumpConfiguration, 
  CPQCanvas, 
  ValidationResult,
  Pricing
} from '../models/types';

// Define the activities that will be called by the workflow
const { 
  collectRequirements, 
  selectConfiguration, 
  validateConfiguration, 
  generateBOM, 
  generatePricing,
  persistCanvas 
} = proxyActivities<typeof activities>({
  startToCloseTimeout: '2 minutes', // Activity must complete in 2 minutes
  scheduleToStartTimeout: '1 second', // Fail immediately if no worker available
});

// Define signals for external interactions
export const updateRequirementsSignal = 
  defineSignal<[Partial<PumpRequirements>]>('updateRequirements');

export const updateConfigurationSignal = 
  defineSignal<[Partial<PumpConfiguration>]>('updateConfiguration');

export const approveConfigurationSignal = 
  defineSignal<[boolean]>('approveConfiguration');

// Workflow interface
export interface QuoteWorkflowParams {
  customer: CustomerInfo;
  initialRequirements?: Partial<PumpRequirements>;
}

// Workflow implementation
export async function quoteWorkflow(params: QuoteWorkflowParams): Promise<CPQCanvas> {
  const { customer, initialRequirements = {} } = params;
  
  // State that will be updated throughout the workflow
  const state: {
    requirements: Partial<PumpRequirements>;
    configuration: Partial<PumpConfiguration>;
    validation: ValidationResult | null;
    pricing: Pricing | null;
    canvas: CPQCanvas | null;
    isApproved: boolean;
  } = {
    requirements: { ...initialRequirements },
    configuration: {},
    validation: null,
    pricing: null,
    canvas: null,
    isApproved: false
  };

  // Set up signal handlers
  setHandler(updateRequirementsSignal, (updates: Partial<PumpRequirements>) => {
    state.requirements = { ...state.requirements, ...updates };
  });

  setHandler(updateConfigurationSignal, (updates: Partial<PumpConfiguration>) => {
    state.configuration = { ...state.configuration, ...updates };
  });

  setHandler(approveConfigurationSignal, (approved: boolean) => {
    state.isApproved = approved;
  });

  // Main workflow steps
  try {
    // Step 1: Collect requirements
    state.requirements = await collectRequirements(customer, state.requirements);
    
    // Step 2: Select configuration based on requirements
    state.configuration = await selectConfiguration(state.requirements);
    
    // Step 3: Validate configuration
    state.validation = await validateConfiguration(
      state.configuration, 
      state.requirements as PumpRequirements
    );
    
    // Wait for configuration approval if there are validation issues
    if (!state.validation.isValid) {
      // In a real implementation, we'd wait for user input here
      // For now, we'll just log the validation issues
      console.log('Configuration validation issues:', state.validation.violations);
      // Wait for approval signal or timeout
      await condition(() => state.isApproved, '5s');
    }
    
    // Step 4: Generate BOM and pricing
    const bom = await generateBOM(state.configuration as PumpConfiguration);
    // Don't pass discountPercent - let it use the default from pricing_rules.json
    state.pricing = await generatePricing(
      state.configuration as PumpConfiguration
    );
    
    // Step 5: Generate CPQ Canvas
    state.canvas = {
      customer,
      requirements: state.requirements as PumpRequirements,
      configuration: state.configuration as PumpConfiguration,
      rationale: state.validation.suggestion || 'Configuration meets all requirements',
      bom: state.pricing?.bom || [],
      pricing: state.pricing || { listTotal: 0, discountPercent: 0, netTotal: 0 },
      openQuestions: [],
      nextSteps: ['Review and approve the quote'],
      timestamp: new Date().toISOString()
    };
    
    // Step 6: Persist the CPQ Canvas
    const savedPath = await persistCanvas(state.canvas);
    console.log(`CPQ Canvas saved to: ${savedPath}`);
    
    return state.canvas;
    
  } catch (error) {
    console.error('Error in quote workflow:', error);
    throw error;
  }
}
