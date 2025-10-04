import { z } from 'zod';

/**
 * Tool schemas for validation and structured calling
 */

// SearchCatalog tool schema
export const SearchCatalogSchema = z.object({
  query: z.string().describe('Search query for catalog (e.g., "family", "motor", "seal")')
});

export type SearchCatalogInput = z.infer<typeof SearchCatalogSchema>;

// ValidateConstraints tool schema
export const ValidateConstraintsSchema = z.object({
  config: z.object({
    family: z.string(),
    impeller: z.string(),
    motorHp: z.number(),
    voltage: z.string(),
    sealType: z.string(),
    material: z.string(),
    mount: z.string(),
    atex: z.boolean()
  }),
  requirements: z.object({
    gpm: z.number().optional(),
    headFt: z.number().optional(),
    fluid: z.string().optional(),
    powerAvailable: z.string().optional(),
    environment: z.string().optional(),
    materialPref: z.string().optional(),
    maintenanceBias: z.string().optional()
  })
});

export type ValidateConstraintsInput = z.infer<typeof ValidateConstraintsSchema>;

// PriceCalculator tool schema
export const PriceCalculatorSchema = z.object({
  config: z.object({
    family: z.string(),
    impeller: z.string(),
    motorHp: z.number(),
    voltage: z.string(),
    sealType: z.string(),
    material: z.string(),
    mount: z.string(),
    atex: z.boolean()
  }),
  discountPercent: z.number().optional()
});

export type PriceCalculatorInput = z.infer<typeof PriceCalculatorSchema>;

// Tool call structure
export const ToolCallSchema = z.object({
  thought: z.string().describe('Brief reasoning about what to do next'),
  action: z.enum(['SearchCatalog', 'ValidateConstraints', 'PriceCalculator', 'BOMExpander', 'PersistCanvas', 'AskQuestion', 'Finish']),
  action_input: z.record(z.any()).describe('JSON object with tool parameters')
});

export type ToolCall = z.infer<typeof ToolCallSchema>;

/**
 * Validate tool input against schema
 */
export function validateToolInput(toolName: string, input: any): { valid: boolean; error?: string; data?: any } {
  try {
    switch (toolName) {
      case 'SearchCatalog':
        const searchData = SearchCatalogSchema.parse(input);
        return { valid: true, data: searchData };
      
      case 'ValidateConstraints':
        const validateData = ValidateConstraintsSchema.parse(input);
        return { valid: true, data: validateData };
      
      case 'PriceCalculator':
      case 'BOMExpander':
        const priceData = PriceCalculatorSchema.parse(input);
        return { valid: true, data: priceData };
      
      default:
        return { valid: true, data: input };
    }
  } catch (error: any) {
    return { 
      valid: false, 
      error: `Invalid input for ${toolName}: ${error.message}` 
    };
  }
}

/**
 * Parse tool call from AI response
 */
export function parseToolCall(response: string): { valid: boolean; toolCall?: ToolCall; error?: string } {
  try {
    // Try to extract JSON from response
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return { valid: false, error: 'No JSON found in response' };
    }
    
    const json = JSON.parse(jsonMatch[0]);
    const toolCall = ToolCallSchema.parse(json);
    
    return { valid: true, toolCall };
  } catch (error: any) {
    return { 
      valid: false, 
      error: `Failed to parse tool call: ${error.message}` 
    };
  }
}

/**
 * Tool definitions for the AI model
 */
export const TOOL_DEFINITIONS = `
Available Tools:

1. SearchCatalog
   Input: { "query": "string" }
   Description: Search the pump catalog by family, options, or specifications
   Example: { "query": "family P100" }

2. ValidateConstraints
   Input: { "config": {...}, "requirements": {...} }
   Description: Validate a pump configuration against business rules
   Returns: { "isValid": boolean, "violations": string[] }

3. PriceCalculator
   Input: { "config": {...}, "discountPercent": number }
   Description: Calculate pricing and generate BOM
   Returns: { "listTotal": number, "netTotal": number, "bom": [...] }

4. BOMExpander
   Input: { "config": {...} }
   Description: Generate detailed Bill of Materials
   Returns: Array of BOM items with SKUs and prices

5. PersistCanvas
   Input: { "canvas": {...} }
   Description: Save the quote to a file
   Returns: { "path": "string" }

6. AskQuestion
   Input: { "question": "string" }
   Description: Ask the user a question to gather more information

7. Finish
   Input: { "message": "string" }
   Description: Complete the conversation with a final message

IMPORTANT: You must respond with valid JSON in this format:
{
  "thought": "Brief reasoning about what to do",
  "action": "ToolName",
  "action_input": { ...parameters... }
}
`;
