/**
 * variantGenerator.js — Auto-generate product variants from minimal input
 *
 * Takes a base product definition and generates all color × size combinations
 * with unique SKUs, ready for bulk database insertion.
 *
 * Usage:
 *   const { generateVariants, previewVariants } = require('./variantGenerator');
 *   const variants = await generateVariants(db, {
 *     name: 'Nike Air Force 1',
 *     brand: 'Nike',
 *     colors: ['White', 'Black'],
 *     sizes: ['40', '41', '42'],
 *     minPrice: 5000,
 *     stock: 10,
 *   });
 */

const { generateSKU, ensureUniqueSKU } = require('./skuGenerator');
const { getSizeCategory, getAvailableSizes, normalizeSize } = require('./sizeValidator');

/**
 * Generate variant definitions from minimal product info
 * @param {object} product - Base product definition
 * @param {string} product.name - Product name
 * @param {string} product.brand - Brand name
 * @param {string} [product.subType] - Model/sub-type (optional)
 * @param {string[]} product.colors - Array of color names
 * @param {string[]} product.sizes - Array of sizes
 * @param {number} product.minPrice - Minimum/base price
 * @param {number} product.stock - Stock per variant (or total if distributeStock=true)
 * @param {object} product.stockMap - Individual stock per variant (color||size -> stock)
 * @param {string} [product.category] - Category name
 * @param {string} [product.topType] - 'shoes' or 'clothes'
 * @param {boolean} [product.distributeStock=false] - If true, stock is total to distribute
 * @param {string} [product.description] - Product description
 * @param {string} [product.photoUrl] - Base photo URL
 * @returns {object[]} Array of variant definitions ready for DB insert
 */
function generateVariantDefinitions(product) {
  const {
    name,
    brand,
    subType,
    colors = [],
    sizes = [],
    minPrice,
    stock = 0,
    stockMap = {},
    category,
    topType,
    distributeStock = false,
    description = '',
    photoUrl = '',
  } = product;

  // Normalize colors and sizes
  const normalizedColors = colors.map(c => String(c).trim()).filter(Boolean);
  const normalizedSizes = sizes.map(s => normalizeSize(s)).filter(Boolean);

  if (!normalizedColors.length || !normalizedSizes.length) {
    // If no colors or sizes, create a single "default" variant
    const defaultStock = stockMap && Object.keys(stockMap).length > 0 
      ? Object.values(stockMap)[0] || parseInt(stock) || 0
      : parseInt(stock) || 0;
    
    return [{
      name: name.trim(),
      brand: brand || '',
      subType: subType || '',
      color: 'Default',
      size: 'One Size',
      sku: null,
      minPrice: parseFloat(minPrice) || 0,
      stock: defaultStock,
      category: category || '',
      topType: topType || '',
      description: description || '',
      photoUrl: photoUrl || '',
    }];
  }

  // Generate all combinations
  const variants = [];
  
  for (const color of normalizedColors) {
    for (const size of normalizedSizes) {
      const key = `${color}||${size}`;
      let variantStock;
      
      // Use stockMap if available (individual stock per variant)
      if (stockMap && stockMap[key] !== undefined && stockMap[key] > 0) {
        variantStock = parseInt(stockMap[key]) || 0;
      } 
      // Otherwise use distributed stock
      else if (distributeStock) {
        variantStock = Math.floor(parseInt(stock) / (normalizedColors.length * normalizedSizes.length));
      } 
      // Or use default stock
      else {
        variantStock = parseInt(stock);
      }
      
      // ONLY include variants with stock > 0
      if (variantStock > 0) {
        variants.push({
          name: name.trim(),
          brand: brand || '',
          subType: subType || '',
          color: color,
          size: size,
          sku: null,
          minPrice: parseFloat(minPrice) || 0,
          stock: variantStock,
          category: category || '',
          topType: topType || '',
          description: description || '',
          photoUrl: photoUrl || '',
        });
      }
    }
  }

  // If distributing stock and no stockMap, handle remainder
  if (distributeStock && (!stockMap || Object.keys(stockMap).length === 0)) {
    const totalVariants = normalizedColors.length * normalizedSizes.length;
    const stockPerVariant = Math.floor(parseInt(stock) / totalVariants);
    if (stockPerVariant > 0) {
      const totalAllocated = stockPerVariant * variants.length;
      let remainder = parseInt(stock) - totalAllocated;
      let idx = 0;
      while (remainder > 0 && idx < variants.length) {
        variants[idx].stock += 1;
        remainder--;
        idx++;
      }
    }
  }

  return variants;
}

/**
 * Generate unique SKUs for all variants
 * @param {object} db - Database connection
 * @param {object[]} variants - Variant definitions from generateVariantDefinitions
 * @returns {Promise<object[]>} Variants with generated SKUs
 */
async function assignSKUs(db, variants) {
  const variantsWithSKU = [];

  for (const variant of variants) {
    // Generate SKU based on brand, subType, color, size
    const sku = await ensureUniqueSKU(db, {
      brand: variant.brand,
      subType: variant.subType,
      color: variant.color,
      size: variant.size,
    });

    variantsWithSKU.push({
      ...variant,
      sku: sku,
    });
  }

  return variantsWithSKU;
}

/**
 * Full variant generation pipeline
 * @param {object} db - Database connection
 * @param {object} product - Base product definition
 * @returns {Promise<object[]>} Complete variant definitions with SKUs
 */
async function generateVariants(db, product) {
  const definitions = generateVariantDefinitions(product);
  if (definitions.length === 0) return [];
  return await assignSKUs(db, definitions);
}

/**
 * Preview variants without database lookup (for UI preview)
 * Generates SKUs without uniqueness check
 * @param {object} product - Base product definition
 * @returns {object[]} Variant definitions with generated (but not unique-checked) SKUs
 */
function previewVariants(product) {
  const definitions = generateVariantDefinitions(product);
  
  return definitions.map(variant => ({
    ...variant,
    sku: generateSKU({
      brand: variant.brand,
      subType: variant.subType,
      color: variant.color,
      size: variant.size,
    }),
  }));
}

/**
 * Validate variant input before generation
 * @param {object} product - Base product definition
 * @returns {{ valid: boolean, errors: string[], warnings: string[] }}
 */
function validateProductInput(product) {
  const errors = [];
  const warnings = [];

  if (!product.name || !product.name.trim()) {
    errors.push('Product name is required');
  }

  if (!product.brand || !product.brand.trim()) {
    errors.push('Brand name is required');
  }

  if (!product.minPrice || parseFloat(product.minPrice) <= 0) {
    errors.push('Minimum price must be greater than 0');
  }

  if ((!product.colors || product.colors.length === 0) && (!product.stockMap || Object.keys(product.stockMap).length === 0)) {
    warnings.push('No colors specified — a single "Default" variant will be created');
  }

  if ((!product.sizes || product.sizes.length === 0) && (!product.stockMap || Object.keys(product.stockMap).length === 0)) {
    warnings.push('No sizes specified — a single "One Size" variant will be created');
  }

  if (product.stock && parseInt(product.stock) < 0) {
    errors.push('Stock cannot be negative');
  }

  if (product.colors && product.colors.length > 20) {
    warnings.push(`Large number of colors (${product.colors.length}) — this will create many variants`);
  }

  if (product.sizes && product.sizes.length > 20) {
    warnings.push(`Large number of sizes (${product.sizes.length}) — this will create many variants`);
  }

  if (product.colors && product.sizes) {
    const totalVariants = product.colors.length * product.sizes.length;
    if (totalVariants > 100) {
      warnings.push(`This will create ${totalVariants} variants — consider splitting into smaller batches`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Prepare bulk insert data for database
 * @param {object[]} variants - Complete variant definitions with SKUs
 * @param {object} options - Insert options
 * @param {number} options.storeId - Store ID (optional)
 * @param {boolean} options.isActive - Active status (default: true)
 * @returns {object[]} Array of product records ready for DB insert
 */
function prepareBulkInsert(variants, options = {}) {
  const { storeId = null, isActive = true } = options;

  return variants.map((variant, index) => ({
    name: variant.name,
    brand: variant.brand,
    sub_type: variant.subType || null,
    color: variant.color,
    size: variant.size,
    sku: variant.sku,
    min_price: variant.minPrice,
    stock: variant.stock,
    category: variant.category || null,
    top_type: variant.topType || null,
    description: variant.description || null,
    photo_url: variant.photoUrl || null,
    store_id: storeId,
    is_active: isActive,
    sort_order: index,
  }));
}

module.exports = {
  generateVariants,
  generateVariantDefinitions,
  assignSKUs,
  previewVariants,
  validateProductInput,
  prepareBulkInsert,
};