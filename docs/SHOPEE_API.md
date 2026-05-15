# Shopee API Reference

## Part 1 — Internal API v4 (used by ShopeeScope scraper)

These are Shopee's undocumented internal APIs. No auth credentials needed — browser session cookies handle authentication automatically. Must run from a shopee.com.my browser tab.

### Base URL
```
https://shopee.com.my/api/v4/
```

### Shop Detail
```
GET /api/v4/shop/get_shop_detail?username={username}
```
Returns: `data.shopid`, `data.name`, `data.follower_count`, `data.item_count`, `data.rating_star`, `data.response_rate`, `data.response_time`, `data.is_official_shop`, `data.is_shopee_verified`, `data.vacation`

### Product Search (by shop)
```
GET /api/v4/search/search_items?by=sales&limit=60&match_id={shopid}&newest={offset}&order=desc&page_type=shop&scenario=PAGE_OTHERS&version=2
```
Returns: `items[]` — each item has `item_basic` containing:
- `itemid`, `shopid`, `name`, `image` (MD5 hash)
- `price_min`, `price_max`, `price_min_before_discount`, `raw_discount`
- `historical_sold`, `sold`, `liked_count`, `view_count`, `stock`
- `item_rating.rating_star`, `item_rating.rating_count[]`
- `brand`, `catid`, `cb_option`, `ctime`

Paginate with `newest` offset (increment by 60). Stop when `items.length < 60`.

### Product Detail (variants)
```
GET /api/v4/item/get?itemid={itemid}&shopid={shopid}
```
Returns: `data.models[]` (variants), `data.tier_variations[]` (variant names/options)

Each model: `modelid`, `name`, `model_sku`, `price`, `stock`, `sold`

### Product Reviews
```
GET /api/v2/item/get_ratings?itemid={itemid}&shopid={shopid}&limit=10&offset=0&filter=0&type=0&exclude_filter=1&flag=1&fold_filter=0&relevant_reviews=false&request_source=2
```
Returns: `data.ratings[]` each with:
- `rating_star`, `comment`, `author_username`, `ctime`
- `product_items[0].variation_name` (variant bought)
- `tags[]`, `reply.comment` (seller reply)

### Image URL Construction
```
https://down-my.img.susercontent.com/file/{image_hash}
```
The `image` field from product search is an MD5 hash — append to this base URL.

### Product URL Construction
```
https://shopee.com.my/{username}-i.{shopid}.{itemid}
```

### Required Headers
```js
{ 'x-api-source': 'pc', 'x-shopee-language': 'en' }
```

---

## Part 2 — Open API v2 (official Partner API)

Official Shopee Partner API requiring seller authorization. Used for managing your own shop (VINUSTORE), not competitor scraping.

### Base URL
```
https://partner.shopeemobile.com/api/v2/
```

### Authentication

Every request requires these query parameters:

| Parameter | Description | Expiry |
|---|---|---|
| `partner_id` | Your app ID from Shopee Partner Portal | Permanent |
| `shop_id` | Seller's shop ID | Permanent |
| `access_token` | OAuth bearer token | 4 hours |
| `refresh_token` | Used to renew access_token | 30 days |
| `timestamp` | Unix timestamp (integer) | 5 min window |
| `sign` | HMAC-SHA256 signature | Per request |

**Signature formula:**
```
sign = HMAC-SHA256(
  key: partner_secret,
  msg: partner_id + "/" + api_path + timestamp + access_token + shop_id
)
```

**OAuth flow:**
1. Generate auth link: `GET /api/v2/shop/auth_partner?partner_id=...&redirect=...&timestamp=...&sign=...`
2. Shop owner authorizes → redirected with `authorization_code` + `shop_id`
3. Exchange code for tokens: `POST /api/v2/auth/token/get`
4. Refresh tokens before expiry: `POST /api/v2/auth/access_token/get`

### Rate Limits
- 100 requests/minute per partner app
- HTTP 429 on excess → use exponential backoff

### API Categories

#### Shop
| Endpoint | Description |
|---|---|
| `GET /shop/get_info` | Basic shop info |
| `GET /shop/get_profile` | Shop profile |
| `POST /shop/update_profile` | Update shop settings |
| `GET /shop/get_shop_list_by_merchant` | All shops under a merchant |

#### Product
| Endpoint | Description |
|---|---|
| `GET /product/get_item_list` | List all products (with filters) |
| `GET /product/get_item_detail` | Full product details |
| `POST /product/add_item` | Create new listing |
| `POST /product/update_item` | Update listing |
| `POST /product/delete_item` | Delete listing |
| `GET /product/get_category` | Category tree |
| `GET /product/get_attributes` | Category attributes |
| `POST /product/update_stock` | Update stock levels |
| `POST /product/update_price` | Update pricing |

#### Order
| Endpoint | Description |
|---|---|
| `GET /order/get_order_list` | List orders (filter by status, date) |
| `GET /order/get_order_detail` | Full order details |
| `POST /order/cancel_order` | Cancel an order |
| `GET /order/get_shipment_list` | Orders ready to ship |

#### Logistics
| Endpoint | Description |
|---|---|
| `GET /logistics/get_shipping_parameter` | Available shipping options |
| `GET /logistics/get_tracking_number` | Track an order |
| `POST /logistics/ship_order` | Mark as shipped |
| `GET /logistics/get_address_list` | Pickup addresses |

#### Marketing
| Endpoint | Description |
|---|---|
| `POST /discount/add_discount` | Create shop discount |
| `GET /discount/get_discount` | Get discount details |
| `POST /voucher/add_voucher` | Create voucher |
| `POST /bundle_deal/add_bundle_deal` | Create bundle deal |
| `POST /add_on_deal/add_add_on_deal` | Create add-on deal |
| `POST /top_picks/add_top_picks_list` | Set featured products |

#### Finance
| Endpoint | Description |
|---|---|
| `GET /payment/get_escrow_detail` | Order payment escrow |
| `GET /payment/get_wallet_balance` | Shop wallet balance |

#### Media
| Endpoint | Description |
|---|---|
| `POST /media_space/upload_image_by_url` | Upload product image |
| `POST /media_space/upload_image` | Upload image file |

### Standard Response Format
```json
{
  "error": "",
  "message": "success",
  "response": { ... },
  "request_id": "abc123"
}
```
Non-empty `error` field = failed request. Check `message` for details.

### Common Error Codes
| Code | Meaning |
|---|---|
| `error_auth` | Invalid/expired token |
| `error_param` | Missing or invalid parameter |
| `error_server` | Shopee server error (retry) |
| `error_not_found` | Resource doesn't exist |
| `error_permission` | App lacks permission for endpoint |

---

## Part 3 — Which API to use for what

| Use Case | API to Use |
|---|---|
| Competitor product scraping | Internal v4 (browser + session cookies) |
| Competitor shop stats | Internal v4 |
| Competitor reviews | Internal v2 get_ratings |
| Manage VINUSTORE listings | Open API v2 |
| VINUSTORE order processing | Open API v2 |
| VINUSTORE marketing campaigns | Open API v2 |
| VINUSTORE inventory sync | Open API v2 |

> **Note:** Open API v2 requires each shop owner to authorize your app via OAuth. You cannot use it to access competitor shops — only shops that grant your app permission.
