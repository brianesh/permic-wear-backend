# 👕 Adding Cloth Types (Shirts, Trousers, Vests, etc.)

## Current System Architecture

In your database, cloth types (Shirts, Trousers, Vests, etc.) are stored as **brands** with `top_type='clothes'`. This is by design to keep the schema simple.

**Database Structure:**
- `brands` table stores both shoe brands (Nike, Adidas) AND cloth types (Shirts, Trousers)
- `top_type` column distinguishes between 'shoes' and 'clothes'
- For clothes: `brand.name` = "Shirts", `brand.top_type` = "clothes"

## Current Issue

The Inventory page's category navigation (`useCategoryNav`) shows:
- **For Shoes**: Top Type → Brands (Nike, Adidas) → Sub-Types (Air Force 1, Dunk)
- **For Clothes**: Top Type → Brands (Shirts, Trousers) → [No sub-types shown]

The problem is that when viewing clothes, there's no button to add new cloth types (new "brands").

## Solution Options

### Option 1: Add "Add Cloth Type" Button (Recommended)

Add a button in the Inventory page when viewing the clothes category that allows admins to create new cloth types.

**Implementation:**
1. In `Inventory.jsx`, when `cat.topType === 'clothes'` and `cat.level === 'brands'`, show an "Add Cloth Type" button
2. Clicking it opens a modal to enter the cloth type name (e.g., "Polo Shirts", "Joggers")
3. POST to `/api/categories/brands` with `{ name: "Polo Shirts", top_type: "clothes" }`

**Code to add:**
```jsx
{cat.topType === 'clothes' && cat.level === 'brands' && isAdmin && (
  <button className="primary-btn" onClick={openAddClothType}>
    + Add Cloth Type
  </button>
)}
```

### Option 2: Use Existing "Add Product" Flow

Alternatively, when creating a product with top_type='clothes', allow users to:
1. Select an existing cloth type from a dropdown
2. Or type a new cloth type name (which creates it on the fly)

This is already partially supported in the bulk-create flow.

## Backend API Already Supports This

The backend API endpoint already exists:
```
POST /api/categories/brands
Body: { name: "Polo Shirts", top_type: "clothes" }
```

This will create a new cloth type that appears in the category navigation.

## Quick Fix

The simplest fix is to add an "Add Cloth Type" button in the Inventory page when viewing clothes brands. This requires a small frontend change.

Would you like me to implement this?