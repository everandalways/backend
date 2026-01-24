/**
 * Rate Limiting Test Utilities
 * 
 * Use these utilities to test rate limiting in different scenarios:
 * - Normal API requests
 * - Rate limit threshold testing
 * - Stripe webhook bypass verification
 * - GraphQL security verification
 */

// ============================================
// 1. Basic Rate Limit Testing (Node.js/cURL)
// ============================================

/**
 * Example: Test rate limiting with sequential requests
 * 
 * Usage in Node.js:
 * node -e "$(cat src/test-rate-limiting.js)"
 */

async function testRateLimitingSequential(apiUrl: string, requestCount: number = 150) {
    console.log(`Testing ${apiUrl} with ${requestCount} sequential requests...`);
    console.log(`Rate limit: 100 requests per minute`);
    console.log(`Expected: ~100 succeed (200), ~50 fail (429)\n`);
    
    let successCount = 0;
    let rateLimitedCount = 0;
    let errors: string[] = [];
    
    for (let i = 1; i <= requestCount; i++) {
        try {
            const response = await fetch(`${apiUrl}/shop-api/`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ query: '{ products { id } }' }),
            });
            
            if (response.status === 200) {
                successCount++;
            } else if (response.status === 429) {
                rateLimitedCount++;
                console.log(`Request ${i}: Rate limited (429)`);
            } else {
                console.log(`Request ${i}: ${response.status}`);
            }
            
            process.stdout.write(`\rProgress: ${i}/${requestCount}`);
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            errors.push(`Request ${i}: ${errorMessage}`);
        }
    }
    
    console.log(`\n\n✓ Results:`);
    console.log(`  Success (200): ${successCount}`);
    console.log(`  Rate Limited (429): ${rateLimitedCount}`);
    console.log(`  Errors: ${errors.length}`);
    
    if (errors.length > 0) {
        console.log(`\nErrors:`, errors);
    }
}

// ============================================
// 2. Stripe Webhook Bypass Testing
// ============================================

/**
 * Test that Stripe webhooks bypass rate limiting
 * 
 * This should succeed even when the rate limit has been exceeded
 */
async function testStripeWebhookBypass(apiUrl: string) {
    console.log('Testing Stripe webhook bypass...\n');
    
    // First, exhaust the rate limit
    console.log('Step 1: Exhausting rate limit (150 requests)...');
    for (let i = 0; i < 150; i++) {
        try {
            await fetch(`${apiUrl}/shop-api/`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
            });
        } catch (e) {
            // Ignore errors
        }
        if ((i + 1) % 50 === 0) {
            console.log(`  ${i + 1} requests sent`);
        }
    }
    
    // Now try the Stripe webhook - should still succeed
    console.log('\nStep 2: Testing Stripe webhook...');
    const webhookResponse = await fetch(`${apiUrl}/payments/stripe/webhook`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Stripe-Signature': 'test_signature',
        },
        body: JSON.stringify({
            type: 'charge.succeeded',
            data: { object: { id: 'ch_test' } },
        }),
    });
    
    const webhookResult = await webhookResponse.json();
    
    if (webhookResponse.status === 429) {
        console.log('✗ FAILED: Webhook was rate limited (429)');
        console.log('  Fix: Check Stripe webhook route patterns in rate-limit.plugin.ts');
    } else if (webhookResponse.status < 400) {
        console.log('✓ SUCCESS: Webhook bypassed rate limiting');
        console.log(`  Response: ${webhookResponse.status}`);
    } else {
        console.log('⚠ WARNING: Webhook returned error (but not 429)');
        console.log(`  Status: ${webhookResponse.status}`);
        console.log(`  Body:`, webhookResult);
    }
}

// ============================================
// 3. GraphQL Security Testing
// ============================================

/**
 * Test that GraphQL introspection is disabled in production
 */
async function testGraphQLSecurity(apiUrl: string) {
    console.log('Testing GraphQL security settings...\n');
    
    // Test introspection query
    const introspectionQuery = `
        query IntrospectionQuery {
            __schema {
                types {
                    name
                }
            }
        }
    `;
    
    console.log('Sending introspection query...');
    const response = await fetch(`${apiUrl}/shop-api/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: introspectionQuery }),
    });
    
    const body = await response.json();
    
    if (body.errors && body.errors[0]?.message?.includes('introspection')) {
        console.log('✓ SUCCESS: Introspection disabled (security enabled)');
        console.log(`  Error: ${body.errors[0].message}`);
    } else if (body.data && body.data.__schema) {
        console.log('✗ FAILED: Introspection enabled (security risk)');
        console.log('  Fix: Ensure APP_ENV=prod and graphQLIntrospection=false in vendure-config.ts');
    } else {
        console.log('⚠ WARNING: Unexpected response');
        console.log('  Response:', body);
    }
}

// ============================================
// 4. Rate Limit Headers Testing
// ============================================

/**
 * Test that rate limit headers are present in responses
 */
async function testRateLimitHeaders(apiUrl: string) {
    console.log('Testing rate limit headers...\n');
    
    const response = await fetch(`${apiUrl}/shop-api/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
    });
    
    const headers = Array.from(response.headers.entries());
    const rateLimitHeaders = headers.filter(([key]) => 
        key.toLowerCase().includes('ratelimit') || 
        key.toLowerCase().includes('throttle') ||
        key.toLowerCase().includes('x-rate')
    );
    
    if (rateLimitHeaders.length === 0) {
        console.log('ℹ INFO: No rate limit headers found in response');
        console.log('  This may be expected depending on throttler configuration');
        console.log('  Headers present:');
        headers.forEach(([key]) => console.log(`    - ${key}`));
    } else {
        console.log('✓ Rate limit headers found:');
        rateLimitHeaders.forEach(([key, value]) => {
            console.log(`  ${key}: ${value}`);
        });
    }
}

// ============================================
// 5. Load Testing
// ============================================

/**
 * Simulate concurrent requests
 * Use a load testing tool like Apache Bench:
 * 
 * ab -n 200 -c 10 http://localhost:3000/shop-api/
 * 
 * This sends 200 total requests with 10 concurrent connections
 * Expected: ~100 succeed, ~100 fail with 429
 */

function getLoadTestingCommand(url: string): string {
    return `ab -n 200 -c 10 -m POST -H "Content-Type: application/json" ${url}/shop-api/`;
}

// ============================================
// 6. Environment Verification
// ============================================

/**
 * Verify that the rate limiting is properly configured in the environment
 */
function verifyEnvironment() {
    console.log('Environment Verification\n');
    
    const checks = {
        'APP_ENV defined': process.env.APP_ENV ? '✓' : '✗',
        'APP_ENV is prod': process.env.APP_ENV === 'prod' ? '✓' : '⚠ (dev)',
        'THROTTLE_LIMIT_PER_MINUTE defined': process.env.THROTTLE_LIMIT_PER_MINUTE ? '✓' : '✗',
        'Rate limit value': process.env.THROTTLE_LIMIT_PER_MINUTE || 'Not set',
    };
    
    Object.entries(checks).forEach(([check, result]) => {
        console.log(`${check}: ${result}`);
    });
}

// ============================================
// 7. Manual Testing Checklist
// ============================================

/**
 * Manual testing checklist for rate limiting verification
 */
function printTestChecklist() {
    console.log(`
# Rate Limiting Manual Test Checklist

## Basic Tests
- [ ] Server starts without errors
- [ ] GraphQL playground unavailable in production
- [ ] GraphQL introspection returns error in production

## Rate Limiting Tests
- [ ] Single request to /shop-api/ succeeds (200)
- [ ] 150 sequential requests: ~100 succeed, ~50 get 429
- [ ] Rate limit error has proper HTTP 429 status
- [ ] Rate limit error message is clear

## Stripe Webhook Tests
- [ ] Stripe webhook succeeds even after rate limit exceeded
- [ ] Webhook signature validation still works
- [ ] Webhook processes successfully and returns 200

## Performance Tests
- [ ] Response time not significantly impacted
- [ ] No memory leaks after extended testing
- [ ] Server handles sustained traffic without issues

## Security Tests
- [ ] GraphQL introspection disabled
- [ ] GraphQL playground unavailable
- [ ] Admin API requires authentication
- [ ] Shop API accessible without auth

## Client Tests
- [ ] Client handles 429 responses gracefully
- [ ] Client implements exponential backoff
- [ ] Client displays rate limit error message
- [ ] Client can recover after waiting
    `);
}

// ============================================
// Export for use in test files
// ============================================

export {
    testRateLimitingSequential,
    testStripeWebhookBypass,
    testGraphQLSecurity,
    testRateLimitHeaders,
    getLoadTestingCommand,
    verifyEnvironment,
    printTestChecklist,
};

// ============================================
// Run checks if executed directly
// ============================================

if (require.main === module) {
    verifyEnvironment();
    printTestChecklist();
}
