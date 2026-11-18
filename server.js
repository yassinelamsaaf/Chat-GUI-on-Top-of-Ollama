
import express from "express";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { rateLimit } from "express-rate-limit";

const app = express();

const PORT = 3000;
const OLLAMA_URL = "http://127.0.0.1:11434";
const DEFAULT_MODEL = "gemma4:e2b";

// Base64 images are larger than their original files, so allow a bounded
// request body that can carry a few small attachments and chat history.
app.use(express.json({ limit: "8mb" }));
app.use(express.static("public"));

// Serve only the browser-ready builds of the Markdown and sanitizing libraries.
app.use("/vendor/marked", express.static("node_modules/marked/lib"));
app.use("/vendor/dompurify", express.static("node_modules/dompurify/dist"));

// Limit API traffic to 20 requests per client during each one-minute window.
// This in-memory limiter is suitable for a local demo; a multi-server app
// should use authenticated per-user limits and a shared rate-limit store.
const apiLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 20,
    standardHeaders: "draft-8",
    legacyHeaders: false,

    message: {
        error: "Too many requests. Try again later."
    }
});

app.use("/api", apiLimiter);

// Chat endpoint
app.post("/api/chat", async (req, res) => {
    const {
        messages,
        model = DEFAULT_MODEL,
        stream = true,
        think,
        systemPrompt = "",
        temperature = 0.7,
        numCtx = 2048
    } = req.body ?? {};

    if (!Array.isArray(messages) || messages.length === 0) {
        return res.status(400).json({
            error: "Messages must be a non-empty array"
        });
    }

    // Reject invalid sampling values before forwarding a request to Ollama.
    if (
        typeof temperature !== "number" ||
        !Number.isFinite(temperature) ||
        temperature < 0 ||
        temperature > 1
    ) {
        return res.status(400).json({
            error: "Temperature must be between 0 and 1"
        });
    }

    // Bound the context window to a useful demo range because larger values
    // can increase memory use significantly.
    if (
        !Number.isInteger(numCtx) ||
        numCtx < 512 ||
        numCtx > 8192
    ) {
        return res.status(400).json({
            error: "Context size must be an integer between 512 and 8192"
        });
    }

    const controller = new AbortController();

    // Detect when the browser disconnects
    res.on("close", () => {
        if (!res.writableEnded) {
            controller.abort();
        }
    });

    try {
        // Prepend the optional system instruction so it guides the full chat.
        const ollamaMessages = [
            ...(typeof systemPrompt === "string" && systemPrompt.trim()
                ? [{ role: "system", content: systemPrompt.trim() }]
                : []),
            ...messages
        ];

        const ollamaBody = {
            model,
            messages: ollamaMessages,
            stream,
            options: {
                temperature,
                num_ctx: numCtx
            }
        };

        // Pass think only when supplied
        if (think !== undefined) {
            ollamaBody.think = think;
        }

        const ollamaResponse = await fetch(
            `${OLLAMA_URL}/api/chat`,
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/json"
                },
                body: JSON.stringify(ollamaBody),
                signal: controller.signal
            }
        );

        if (!ollamaResponse.ok) {
            const errorText = await ollamaResponse.text();

            return res.status(502).json({
                error: errorText
            });
        }

        // Non-streaming response
        if (!stream) {
            const data = await ollamaResponse.json();
            return res.json(data);
        }

        // Streaming response
        res.setHeader(
            "Content-Type",
            "application/x-ndjson; charset=utf-8"
        );

        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("X-Accel-Buffering", "no");

        await pipeline(
            Readable.fromWeb(ollamaResponse.body),
            res
        );

    } catch (error) {
        if (controller.signal.aborted || error.name === "AbortError") {
            return;
        }

        console.error("Chat error:", error);

        if (!res.headersSent) {
            res.status(502).json({
                error: "Cannot reach Ollama"
            });
        } else {
            res.end();
        }
    }
});

// Model discovery endpoint
app.get("/api/models", async (req, res) => {
    try {
        const tagsResponse = await fetch(
            `${OLLAMA_URL}/api/tags`
        );

        if (!tagsResponse.ok) {
            throw new Error("Cannot retrieve models");
        }

        const tagsData = await tagsResponse.json();

        const models = await Promise.all(
            tagsData.models.map(async (model) => {
                const showResponse = await fetch(
                    `${OLLAMA_URL}/api/show`,
                    {
                        method: "POST",
                        headers: {
                            "Content-Type": "application/json"
                        },
                        body: JSON.stringify({
                            model: model.name
                        })
                    }
                );

                if (!showResponse.ok) {
                    throw new Error(
                        `Cannot inspect ${model.name}`
                    );
                }

                const details = await showResponse.json();

                return {
                    name: model.name,
                    capabilities: details.capabilities ?? []
                };
            })
        );

        res.json(models);

    } catch (error) {
        console.error("Model discovery error:", error);

        res.status(502).json({
            error: "Cannot retrieve local models"
        });
    }
});

// Start server
app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});
