import { DataStore } from '../data/loaders';
import { 
  CustomerInfo, 
  PumpRequirements, 
  PumpConfiguration, 
  CPQCanvas,
  ValidationResult
} from '../models/types';
import { 
  validateConfiguration as validateConfig,
  calculatePricing
} from '../agent/tools';
import * as fs from 'fs';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';

// Ensure the runs directory exists
const RUNS_DIR = path.join(process.cwd(), 'runs');
if (!fs.existsSync(RUNS_DIR)) {
  fs.mkdirSync(RUNS_DIR, { recursive: true });
}

/**
 * Activity to collect pump requirements from the customer
 * This uses the ReAct agent to interactively gather requirements
 */
export async function collectRequirements(
  customer: CustomerInfo,
  initialRequirements: Partial<PumpRequirements> = {}
): Promise<PumpRequirements> {
  // Return the requirements that were already collected via CLI
  // The CLI interaction happens before the workflow starts
  return {
    gpm: initialRequirements.gpm || 0,
    headFt: initialRequirements.headFt || 0,
    fluid: initialRequirements.fluid || 'water',
    powerAvailable: initialRequirements.powerAvailable || '460V_3ph',
    environment: initialRequirements.environment || 'non-ATEX',
    materialPref: initialRequirements.materialPref || 'CastIron',
    maintenanceBias: initialRequirements.maintenanceBias || 'budget',
    siteConstraints: initialRequirements.siteConstraints || [],
    ...initialRequirements
  };
}

/**
 * Activity to select a pump configuration based on requirements
 */
export async function selectConfiguration(
  requirements: Partial<PumpRequirements>
): Promise<Partial<PumpConfiguration>> {
  const { gpm = 0, headFt = 0, environment, maintenanceBias, materialPref } = requirements;
  
  // Find matching pump family and motor HP from flow/head map
  let selectedFamily = '';
  let selectedMotorHp = 0;
  let selectedImpeller = '';
  
  for (const entry of DataStore.flowHeadMap) {
    const [minGpm, maxGpm] = entry.gpmRange.split('-').map(Number);
    const [minHead, maxHead] = entry.headRange.split('-').map(Number);
    
    if (gpm >= minGpm && gpm <= maxGpm && 
        headFt >= minHead && headFt <= maxHead) {
      selectedFamily = entry.family;
      selectedMotorHp = entry.motorHp;
      selectedImpeller = entry.impellerCode;
      break;
    }
  }
  
  if (!selectedFamily) {
    // Fallback: select the smallest pump if no exact match
    console.warn(`No exact match for GPM=${gpm}, Head=${headFt}. Using fallback pump.`);
    const fallback = DataStore.flowHeadMap[0]; // Use first entry as fallback
    selectedFamily = fallback.family;
    selectedMotorHp = fallback.motorHp;
    selectedImpeller = fallback.impellerCode;
  }
  
  // Determine voltage based on motor HP
  const voltage = selectedMotorHp <= 3 ? '230V_1ph' : '460V_3ph';
  
  // Determine seal type based on maintenance bias
  const sealType = maintenanceBias === 'low maintenance' ? 'Mechanical' : 'Packing';
  
  // Determine material
  const material = materialPref === 'Stainless' || environment === 'ATEX' ? 'Stainless' : 'CastIron';
  
  // Determine mount type
  const mount = selectedMotorHp <= 7.5 ? 'CloseCoupled' : 'Base';
  
  return {
    family: selectedFamily,
    motorHp: selectedMotorHp,
    voltage,
    sealType,
    material,
    mount,
    impeller: selectedImpeller,
    atex: environment === 'ATEX'
  };
}

/**
 * Activity to validate a pump configuration
 */
export async function validateConfiguration(
  config: Partial<PumpConfiguration>,
  requirements: Partial<PumpRequirements>
): Promise<ValidationResult> {
  return validateConfig(config, requirements);
}

/**
 * Activity to generate a Bill of Materials (BOM)
 */
export async function generateBOM(
  config: PumpConfiguration
): Promise<any> {
  // The BOM is generated as part of the pricing calculation
  // This is a placeholder that will be filled by the pricing activity
  return [];
}

/**
 * Activity to generate pricing for a configuration
 */
export async function generatePricing(
  config: PumpConfiguration,
  discountPercent?: number
) {
  return calculatePricing(config, discountPercent);
}

/**
 * Activity to persist the CPQ Canvas to a file
 */
export async function persistCanvas(canvas: CPQCanvas): Promise<string> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `quote-${timestamp}-${uuidv4().substring(0, 8)}.md`;
  const filePath = path.join(RUNS_DIR, filename);
  
  // Create a clean copy of the canvas without circular references
  const cleanCanvas = JSON.parse(JSON.stringify(canvas));
  
  // Write JSON file with formatted output
  const jsonFilePath = filePath.replace('.md', '.json');
  
  // Create a formatted version with "Yes"/"No" for atex
  const formattedCanvas = {
    ...cleanCanvas,
    configuration: {
      ...cleanCanvas.configuration,
      atex: cleanCanvas.configuration.atex ? 'Yes' : 'No'
    }
  };
  
  fs.writeFileSync(jsonFilePath, JSON.stringify(formattedCanvas, null, 2), 'utf-8');
  
  // Also save as Markdown
  const markdownPath = filePath;
  const markdownContent = generateMarkdown(cleanCanvas);
  fs.writeFileSync(markdownPath, markdownContent, 'utf-8');
  
  return markdownPath;
}

/**
 * Helper function to generate Markdown from CPQ Canvas
 */
function generateMarkdown(canvas: CPQCanvas): string {
  const { customer, requirements, configuration, rationale, bom, pricing, openQuestions, nextSteps } = canvas;
  
  let markdown = `# Pump Configuration Quote

## Customer Information
- **Name:** ${customer.name}
- **Company:** ${customer.company}
${customer.email ? `- **Email:** ${customer.email}\n` : ''}${customer.phone ? `- **Phone:** ${customer.phone}\n` : ''}
`;

  // Requirements
  markdown += `## Requirements
`;
  markdown += `- **Flow Rate:** ${requirements.gpm} GPM
`;
  markdown += `- **Head:** ${requirements.headFt} ft
`;
  markdown += `- **Fluid:** ${requirements.fluid}
`;
  markdown += `- **Power Available:** ${requirements.powerAvailable}
`;
  markdown += `- **Environment:** ${requirements.environment}
`;
  markdown += `- **Material Preference:** ${requirements.materialPref || 'Not specified'}
`;
  markdown += `- **Maintenance Bias:** ${requirements.maintenanceBias || 'Not specified'}
`;
  
  if (requirements.siteConstraints && requirements.siteConstraints.length > 0) {
    markdown += `- **Site Constraints:** ${requirements.siteConstraints.join(', ')}
`;
  }
  
  if (requirements.notes) {
    markdown += `- **Notes:** ${requirements.notes}
`;
  }
  
  // Configuration
  markdown += `
## Selected Configuration
`;
  markdown += `- **Pump Family:** ${configuration.family}
`;
  markdown += `- **Motor HP:** ${configuration.motorHp}
`;
  markdown += `- **Voltage:** ${configuration.voltage}
`;
  markdown += `- **Seal Type:** ${configuration.sealType}
`;
  markdown += `- **Material:** ${configuration.material}
`;
  markdown += `- **Mount:** ${configuration.mount}
`;
  markdown += `- **Impeller:** ${configuration.impeller}
`;
  markdown += `- **ATEX Certified:** ${configuration.atex ? 'Yes' : 'No'}
`;
  
  // Rationale
  markdown += `
## Selection Rationale
${rationale}
`;
  
  // BOM
  markdown += `
## Bill of Materials (BOM)
`;
  markdown += `| Quantity | SKU | Description | Unit Price | Extended Price |
|----------|-----|-------------|------------|----------------|
`;
  
  bom.forEach(item => {
    markdown += `| ${item.quantity} | ${item.sku} | ${item.description} | $${item.unitPrice.toFixed(2)} | $${item.extendedPrice.toFixed(2)} |
`;
  });
  
  // Pricing Summary
  markdown += `
## Pricing Summary
`;
  markdown += `- **List Price Total:** $${pricing.listTotal.toFixed(2)}\n`;
  markdown += `- **Discount:** ${pricing.discountPercent}%\n`;
  markdown += `- **Net Price Total:** $${pricing.netTotal.toFixed(2)}\n`;
  
  // Open Questions
  if (openQuestions && openQuestions.length > 0) {
    markdown += `
## Open Questions
`;
    openQuestions.forEach(question => {
      markdown += `- ${question}\n`;
    });
  }
  
  // Next Steps
  if (nextSteps && nextSteps.length > 0) {
    markdown += `
## Next Steps
`;
    nextSteps.forEach(step => {
      markdown += `- ${step}\n`;
    });
  }
  
  // Footer
  markdown += `
---
*Generated on ${new Date().toLocaleString()}*\n`;
  
  return markdown;
}
