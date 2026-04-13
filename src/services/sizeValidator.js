/**
 * sizeValidator.js — Size validation and normalization service
 *
 * Enforces standardized size ranges based on product type:
 *  - Shoes: EU 36-47 (standard), 33-50 (extended), up to 58 (extreme)
 *  - Tops: XS, S, M, L, XL, 2XL, 3XL, 4XL, 5XL, 6XL
 *  - Trousers: waist 28-44 (standard), 26-50 (extended)
 *
 * Features:
 *  - Validates size against product type
 *  - Normalizes size input (e.g., "40" → "40", "XL" → "XL")
 *  - Suggests closest valid size for out-of-range values
 *  - Generates size charts for UI dropdowns
 */

// ── Size definitions ──────────────────────────────────────────────

const SHOE_SIZES = {
  standard: Array.from({ length: 12 }, (_, i) => (36 + i).toString()), // 36-47
  extended: Array.from({ length: 18 }, (_, i) => (33 + i).toString()), // 33-50
  extreme:  Array.from({ length: 26 }, (_, i) => (33 + i).toString()), // 33-58
};

const TOP_SIZES = {
  standard: ['XS', 'S', 'M', 'L', 'XL', '2XL', '3XL'],
  extended: ['XS', 'S', 'M', 'L', 'XL', '2XL', '3XL', '4XL', '5XL'],
  extreme:  ['XS', 'S', 'M', 'L', 'XL', '2XL', '3XL', '4XL', '5XL', '6XL'],
};

const TROUSER_SIZES = {
  standard: Array.from({ length: 29 }, (_, i) => (24 + i).toString()), // 24-52
  extended: Array.from({ length: 29 }, (_, i) => (24 + i).toString()), // 24-52
};

// Map product types to size categories (all keys should be lowercase for matching)
const TYPE_TO_CATEGORY = {
  // Shoes
  'shoes': 'shoes',
  'sneakers': 'shoes',
  'boots': 'shoes',
  'sandals': 'shoes',
  'loafers': 'shoes',
  
  // Tops - including singular and plural forms
  'shirt': 'tops',
  'shirts': 'tops',
  't-shirt': 'tops',
  't-shirts': 'tops',
  'tshirt': 'tops',
  'tshirts': 'tops',
  'polo': 'tops',
  'polos': 'tops',
  'hoodie': 'tops',
  'hoodies': 'tops',
  'jacket': 'tops',
  'jackets': 'tops',
  'vest': 'tops',
  'vests': 'tops',
  'sweater': 'tops',
  'sweaters': 'tops',
  'sweatshirt': 'tops',
  'sweatshirts': 'tops',
  'tracksuit': 'tops',
  'tracksuits': 'tops',
  
  // Bottoms/Trousers - including singular and plural forms
  'trouser': 'trousers',
  'trousers': 'trousers',
  'pant': 'trousers',
  'pants': 'trousers',
  'jean': 'trousers',
  'jeans': 'trousers',
  'short': 'trousers',
  'shorts': 'trousers',
  'chino': 'trousers',
  'chinos': 'trousers',
  
  // Accessories (one size fits all)
  'belt': 'accessories',
  'belts': 'accessories',
  'cap': 'accessories',
  'caps': 'accessories',
  'hat': 'accessories',
  'hats': 'accessories',
};

// ── Validation functions ───────────────────────────────────────────

/**
 * Get the size category for a product type
 */
function getSizeCategory(productType) {
  const type = (productType || '').toLowerCase().trim();
  return TYPE_TO_CATEGORY[type] || 'tops'; // Default to tops
}

/**
 * Get available sizes for a product type
 * @param {string} productType - Product type (e.g., 'shoes', 'shirts')
 * @param {string} range - 'standard' | 'extended' | 'extreme'
 * @returns {string[]} Array of valid sizes
 */
function getAvailableSizes(productType, range = 'standard') {
  const category = getSizeCategory(productType);
  
  switch (category) {
    case 'shoes':
      return SHOE_SIZES[range] || SHOE_SIZES.standard;
    case 'tops':
      return TOP_SIZES[range] || TOP_SIZES.standard;
    case 'trousers':
      return TROUSER_SIZES[range] || TROUSER_SIZES.standard;
    case 'accessories':
      return ['One Size'];
    default:
      return TOP_SIZES.standard;
  }
}

/**
 * Validate a size against a product type
 * @param {string} size - Size to validate
 * @param {string} productType - Product type
 * @param {string} range - 'standard' | 'extended' | 'extreme'
 * @returns {{ valid: boolean, normalized: string, suggestion?: string }}
 */
function validateSize(size, productType, range = 'standard') {
  const normalized = normalizeSize(size);
  const validSizes = getAvailableSizes(productType, range);
  
  if (validSizes.includes(normalized)) {
    return { valid: true, normalized };
  }
  
  // If using standard range, check if it's valid in extended
  if (range === 'standard') {
    const extendedSizes = getAvailableSizes(productType, 'extended');
    if (extendedSizes.includes(normalized)) {
      return {
        valid: false,
        normalized,
        suggestion: `Size "${normalized}" is outside standard range. Consider using extended range.`,
      };
    }
  }
  
  // Find closest valid size
  const suggestion = findClosestSize(normalized, validSizes, productType);
  
  return {
    valid: false,
    normalized,
    suggestion: `Invalid size "${normalized}". Did you mean ${suggestion}?`,
  };
}

/**
 * Normalize a size string to standard format
 */
function normalizeSize(size) {
  if (!size) return '';
  
  let s = String(size).trim().toUpperCase();
  
  // Handle common variations
  const variations = {
    'EXTRA SMALL': 'XS',
    'EXSMALL': 'XS',
    'X-SMALL': 'XS',
    'SMALL': 'S',
    'MEDIUM': 'M',
    'MED': 'M',
    'LARGE': 'L',
    'EXTRA LARGE': 'XL',
    'EXLARGE': 'XL',
    'X-LARGE': 'XL',
    'DOUBLE XL': '2XL',
    'XXL': '2XL',
    'TRIPLE XL': '3XL',
    'XXXL': '3XL',
    'QUAD XL': '4XL',
    'XXXXL': '4XL',
    'QUINTUPLE XL': '5XL',
    'XXXXXL': '5XL',
    'SEXTUPLE XL': '6XL',
    'XXXXXXL': '6XL',
    'ONE SIZE': 'One Size',
    'ONESIZE': 'One Size',
    'OS': 'One Size',
  };
  
  if (variations[s]) {
    return variations[s];
  }
  
  // Handle numeric sizes (remove leading zeros, trim decimals)
  const num = parseFloat(s);
  if (!isNaN(num)) {
    // For shoe sizes, round to nearest 0.5
    if (num >= 30 && num <= 60) {
      return Math.round(num * 2) / 2 .toString();
    }
    // For waist sizes, use integer
    return Math.round(num).toString();
  }
  
  return s;
}

/**
 * Find the closest valid size to a given value
 */
function findClosestSize(size, validSizes, productType) {
  const category = getSizeCategory(productType);
  
  if (category === 'accessories') {
    return 'One Size';
  }
  
  // For numeric sizes, find closest numeric match
  const sizeNum = parseFloat(size);
  if (!isNaN(sizeNum)) {
    const numericSizes = validSizes.map(s => ({ size: s, num: parseFloat(s) })).filter(s => !isNaN(s.num));
    if (numericSizes.length > 0) {
      numericSizes.sort((a, b) => Math.abs(a.num - sizeNum) - Math.abs(b.num - sizeNum));
      return numericSizes[0].size;
    }
  }
  
  // For letter sizes, find closest in sequence
  const letterOrder = ['XS', 'S', 'M', 'L', 'XL', '2XL', '3XL', '4XL', '5XL', '6XL'];
  const sizeIndex = letterOrder.indexOf(size);
  
  if (sizeIndex >= 0) {
    const validIndices = validSizes.map(s => letterOrder.indexOf(s)).filter(i => i >= 0);
    if (validIndices.length > 0) {
      const closest = validIndices.reduce((a, b) => 
        Math.abs(a - sizeIndex) < Math.abs(b - sizeIndex) ? a : b
      );
      return letterOrder[closest];
    }
  }
  
  // Fallback to first valid size
  return validSizes[0] || 'M';
}

/**
 * Generate a size chart for UI dropdowns
 */
function getSizeChart(productType, range = 'standard') {
  const sizes = getAvailableSizes(productType, range);
  const category = getSizeCategory(productType);
  
  return {
    category,
    range,
    sizes,
    labels: sizes.map(size => {
      switch (category) {
        case 'shoes':
          return `EU ${size}`;
        case 'trousers':
          return `Waist ${size}"`;
        default:
          return size;
      }
    }),
  };
}

module.exports = {
  getSizeCategory,
  getAvailableSizes,
  validateSize,
  normalizeSize,
  findClosestSize,
  getSizeChart,
  SHOE_SIZES,
  TOP_SIZES,
  TROUSER_SIZES,
  TYPE_TO_CATEGORY,
};