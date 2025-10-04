import { describe, test, expect } from '@jest/globals';
import { selectConfiguration, generatePricing } from '../src/activities/quote.activities';
import { PumpRequirements } from '../src/models/types';

describe('CPQ Agent - Three Scenarios', () => {
  test('S1: Small, budget pump (40 GPM @ 60 ft, 230V_1ph)', async () => {
    // Inputs
    const requirements: Partial<PumpRequirements> = {
      gpm: 40,
      headFt: 60,
      fluid: 'water',
      powerAvailable: '230V_1ph',
      environment: 'non-ATEX',
      maintenanceBias: 'budget',
      materialPref: 'CastIron'
    };
    
    // Select configuration
    const config = await selectConfiguration(requirements);
    
    // Verify configuration
    expect(config.family).toBe('P100');
    expect(config.motorHp).toBe(3);
    expect(config.voltage).toBe('230V_1ph');
    expect(config.sealType).toBe('Packing');
    expect(config.material).toBe('CastIron');
    expect(config.mount).toBe('CloseCoupled');
    expect(config.impeller).toBe('IMP-100-S');
    expect(config.atex).toBe(false);
    
    // Generate pricing
    const pricing = await generatePricing(config as any);
    
    // Verify pricing (±$1 tolerance)
    expect(pricing.listTotal).toBeCloseTo(1765, 0);
    expect(pricing.discountPercent).toBe(20);
    expect(pricing.netTotal).toBeCloseTo(1412, 0);
  });

  test('S2: Medium, low maintenance (75 GPM @ 100 ft, 460V_3ph)', async () => {
    // Inputs
    const requirements: Partial<PumpRequirements> = {
      gpm: 75,
      headFt: 100,
      fluid: 'water',
      powerAvailable: '460V_3ph',
      environment: 'non-ATEX',
      maintenanceBias: 'low maintenance',
      materialPref: 'CastIron'
    };
    
    // Select configuration
    const config = await selectConfiguration(requirements);
    
    // Verify configuration
    expect(config.family).toBe('P100');
    expect(config.motorHp).toBe(5);
    expect(config.voltage).toBe('460V_3ph');
    expect(config.sealType).toBe('Mechanical');
    expect(config.material).toBe('CastIron');
    expect(config.mount).toBe('CloseCoupled');
    expect(config.impeller).toBe('IMP-120-M');
    expect(config.atex).toBe(false);
    
    // Generate pricing
    const pricing = await generatePricing(config as any);
    
    // Verify pricing (±$1 tolerance)
    expect(pricing.listTotal).toBeCloseTo(2385, 0);
    expect(pricing.discountPercent).toBe(20);
    expect(pricing.netTotal).toBeCloseTo(1908, 0);
  });

  test('S3: ATEX environment (120 GPM @ 150 ft, hydrocarbon, ATEX)', async () => {
    // Inputs
    const requirements: Partial<PumpRequirements> = {
      gpm: 120,
      headFt: 150,
      fluid: 'hydrocarbon',
      powerAvailable: '460V_3ph',
      environment: 'ATEX',
      maintenanceBias: 'low maintenance',
      materialPref: 'Stainless'
    };
    
    // Select configuration
    const config = await selectConfiguration(requirements);
    
    // Verify configuration
    expect(config.family).toBe('P200');
    expect(config.motorHp).toBe(10);
    expect(config.voltage).toBe('460V_3ph');
    expect(config.sealType).toBe('Mechanical');
    expect(config.material).toBe('Stainless');
    expect(config.mount).toBe('Base');
    expect(config.impeller).toBe('IMP-180-XL');
    expect(config.atex).toBe(true);
    
    // Generate pricing
    const pricing = await generatePricing(config as any);
    
    // Verify pricing (±$1 tolerance)
    expect(pricing.listTotal).toBeCloseTo(5415, 0);
    expect(pricing.discountPercent).toBe(20);
    expect(pricing.netTotal).toBeCloseTo(4332, 0);
    
    // Verify ATEX package is included in BOM
    expect(pricing.bom).toBeDefined();
    const atexItem = pricing.bom?.find((item: any) => item.sku === 'ATEX-PKG');
    expect(atexItem).toBeDefined();
    expect(atexItem?.description).toContain('ATEX');
  });
});
