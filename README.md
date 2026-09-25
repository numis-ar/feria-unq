# FairPay Merchant

FairPay Merchant is a GNU Taler-based application that provides a dashboard and middleware for merchants. It consists of a web frontend for the merchant dashboard and a Node.js backend acting as a proxy and helper for Taler operations.

## Backend

The backend is a Node.js/TypeScript application that serves as a middleware to handle withdrawals, latest orders, and closing the merchant account.

### Endpoints

#### `POST /get-money`
Fallback withdrawal endpoint (defaults to instance `default`).

#### `POST /:instance_id/withdraw`
Creates a withdrawal for the given merchant instance.

**Request Body:**
```json
{
  "amount": "NUMIS:10"
}
```
- `amount` (string): The requested withdrawal amount in the format `CURRENCY:VALUE`. 

**Response:**
- `200 OK`: 
  ```json
  { "type": "ok", "uri": "taler://pay-push/..." }
  ```
  or if funds are insufficient:
  ```json
  { "type": "not-enough-funds" }
  ```
- `400 Bad Request`:
  ```json
  { "type": "error", "message": "Invalid amount format..." }
  ```

#### `GET /:instance_id/latest-orders`
Fetches the latest orders for the given merchant instance from the Taler Merchant API, categorized by their status.

**Response:**
- `200 OK`:
  ```json
  {
    "paid": [...],
    "inTransit": [...],
    "ready": [...]
  }
  ```
- `502 Bad Gateway`:
  ```json
  { "type": "error", "message": "Failed to fetch merchant orders" }
  ```

#### `POST /get-money/:instance_id/close-account`
Closes the merchant account by transferring the entire available bank balance to a hardcoded `closing_account`.

**Headers:**
- `Authorization: Bearer <BANK_ACCESS_TOKEN>`

**Response:**
- `200 OK`:
  ```json
  { "type": "ok" }
  ```
- `400 Bad Request`: (e.g. no balance found)
  ```json
  { "type": "error", "message": "No balance found" }
  ```
- `401 Unauthorized`:
  ```json
  { "type": "error", "message": "Unauthorized" }
  ```
- `500 Internal Server Error`:
  ```json
  { "type": "error", "message": "..." }
  ```

## Frontend

The frontend is a single-page HTML application (`web/merchant.html`) styled with Tailwind CSS. It interacts with both the FairPay Backend, the Taler Merchant API, and the Taler Bank API.

### Functionality & Screens

- **Login Modal:** A secure login screen. Upon authentication, it retrieves a token for the Merchant API and another for the Bank API, granting access to the dashboard.
- **Dashboard:** Provides an overview of the merchant's sales and balances (Sold, In Transit, Settled) and lists the latest processed orders.
- **Bank Account:** 
  - **Withdraw:** Allows the merchant to withdraw their available balance to their Taler wallet via a QR code.
  - **Transfer:** Enables transferring funds directly to another merchant's account.
  - **Latest Transactions:** Displays real-time incoming and outgoing transactions.
- **User Settings:** Allows the user to change their password securely and to log out.
- **Close Account:** Provides a mechanism to safely close the merchant account, transferring all remaining funds to a system-designated closing account.

