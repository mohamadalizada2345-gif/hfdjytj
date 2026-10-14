require("dotenv").config();

const express = require("express");
const path = require("path");
const { ethers } = require("ethers");
const { createClient } = require("@supabase/supabase-js");

const app = express();
const PORT = Number(process.env.PORT || 3000);

app.use(express.json({ limit: "20kb" }));

const requiredVariables = [
    "ETHEREUM_RPC_URL",
    "PAYMENT_WALLET",
    "SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY"
];

for (const variable of requiredVariables) {
    if (!process.env[variable]) {
        console.error(`Missing environment variable: ${variable}`);
        process.exit(1);
    }
}

if (!ethers.isAddress(process.env.PAYMENT_WALLET)) {
    console.error("PAYMENT_WALLET is not a valid Ethereum address.");
    process.exit(1);
}

const provider = new ethers.JsonRpcProvider(
    process.env.ETHEREUM_RPC_URL
);

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    {
        auth: {
            persistSession: false,
            autoRefreshToken: false
        }
    }
);

const USDT_ADDRESS =
    "0xdAC17F958D2ee523a2206206994597C13D831ec7";

const TRANSFER_TOPIC = ethers.id(
    "Transfer(address,address,uint256)"
);

const USDT_DECIMALS = 6;
const REQUIRED_AMOUNT = 20_000_000n;
const REQUIRED_CONFIRMATIONS = 3;

app.use(express.static(path.join(__dirname, "..", "public")));

app.get("/api/health", (req, res) => {
    res.json({
        status: "ok",
        service: "MAZ Tools API"
    });
});

async function requireUser(req, res, next) {
    try {
        const authorization = req.headers.authorization || "";
        const match = authorization.match(/^Bearer\s+(.+)$/i);

        if (!match) {
            return res.status(401).json({
                error: "A valid login session is required."
            });
        }

        const accessToken = match[1];

        const { data, error } = await supabase.auth.getUser(accessToken);

        if (error || !data.user) {
            return res.status(401).json({
                error: "Invalid or expired login session."
            });
        }

        req.user = data.user;
        next();
    } catch (error) {
        console.error("Authentication error:", error.message);

        return res.status(401).json({
            error: "Authentication failed."
        });
    }
}

app.post("/api/verify-payment", requireUser, async (req, res) => {
    try {
        const txHash = String(req.body.txHash || "").trim();

        if (!/^0x[a-fA-F0-9]{64}$/.test(txHash)) {
            return res.status(400).json({
                error: "Enter a valid Ethereum transaction hash."
            });
        }

        const network = await provider.getNetwork();

        if (network.chainId !== 1n) {
            return res.status(503).json({
                error: "The payment verifier is not connected to Ethereum Mainnet."
            });
        }

        const receipt = await provider.getTransactionReceipt(txHash);

        if (!receipt) {
            return res.status(400).json({
                error: "Transaction not found. Check the hash and try again."
            });
        }

        if (receipt.status !== 1) {
            return res.status(400).json({
                error: "The transaction failed."
            });
        }

        const latestBlock = await provider.getBlockNumber();
        const confirmations = latestBlock - receipt.blockNumber + 1;

        if (confirmations < REQUIRED_CONFIRMATIONS) {
            return res.status(400).json({
                error: "The transaction needs at least 3 confirmations.",
                confirmations
            });
        }

        const paymentWallet = ethers.getAddress(
            process.env.PAYMENT_WALLET
        );

        const matchingTransfers = [];

        for (const log of receipt.logs) {
            if (
                log.address.toLowerCase() !== USDT_ADDRESS.toLowerCase()
            ) {
                continue;
            }

            if (
                log.topics.length !== 3 ||
                log.topics[0] !== TRANSFER_TOPIC
            ) {
                continue;
            }

            const recipient = ethers.getAddress(
                "0x" + log.topics[2].slice(-40)
            );

            if (recipient !== paymentWallet) {
                continue;
            }

            const amount = BigInt(log.data);

            if (amount === REQUIRED_AMOUNT) {
                matchingTransfers.push({
                    recipient,
                    amount: amount.toString()
                });
            }
        }

        if (matchingTransfers.length !== 1) {
            return res.status(400).json({
                error:
                    "No single exact transfer of 20 USDT to the payment wallet was found."
            });
        }

        const { data: payment, error: paymentError } = await supabase
            .rpc("activate_maz_subscription", {
                p_user_id: req.user.id,
                p_tx_hash: txHash.toLowerCase(),
                p_amount: REQUIRED_AMOUNT.toString(),
                p_wallet: paymentWallet.toLowerCase()
            });

        if (paymentError) {
            console.error("Subscription activation error:", paymentError.message);

            return res.status(409).json({
                error:
                    "Payment verification could not be completed. Contact support before paying again."
            });
        }

        return res.json({
            success: true,
            message: "Payment verified and subscription activated.",
            subscription: payment
        });
    } catch (error) {
        console.error("Payment verification error:", error.message);

        return res.status(500).json({
            error: "An internal error occurred while verifying payment."
        });
    }
});

app.listen(PORT, () => {
    console.log(`MAZ Tools server running on port ${PORT}`);
});