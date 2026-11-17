
// ===============================
// DOM ELEMENTS
// ===============================

const messagesContainer =
    document.getElementById("messages");

const chatForm =
    document.getElementById("chat-form");

const messageInput =
    document.getElementById("message-input");

const sendButton =
    document.getElementById("send-button");

const stopButton =
    document.getElementById("stop-button");

const newChatButton =
    document.getElementById("new-chat");

const modelSelect =
    document.getElementById("model-select");

const thinkControl =
    document.getElementById("think-control");

const thinkToggle =
    document.getElementById("think-toggle");

// Advanced generation settings are sent with every chat request.
const systemPromptInput =
    document.getElementById("system-prompt");

const temperatureInput =
    document.getElementById("temperature");

const temperatureValue =
    document.getElementById("temperature-value");

const contextSizeInput =
    document.getElementById("num-ctx");

const contextSizeValue =
    document.getElementById("num-ctx-value");

const imageControl =
    document.getElementById("image-control");

const imageInput =
    document.getElementById("image-input");

const imageStatus =
    document.getElementById("image-status");

const statusElement =
    document.getElementById("status");


// ===============================
// APPLICATION STATE
// ===============================

let history = [];

let activeController = null;

let isGenerating = false;

let modelCapabilities = {};

// Holds only the currently selected attachment; sent chat history keeps its
// own base64 image data on the corresponding user message.
let selectedImage = null;


// ===============================
// MESSAGE DISPLAY
// ===============================

function addMessage(role, content = "") {

    const messageElement =
        document.createElement("div");

    messageElement.className = `message ${role}`;

    const roleElement =
        document.createElement("div");

    roleElement.className = "message-role";

    roleElement.textContent =
        role === "user" ? "You" : "Assistant";

    const contentElement =
        document.createElement("div");

    contentElement.className = "message-content";

    // Never interpret model output as HTML
    contentElement.textContent = content;

    messageElement.appendChild(roleElement);
    messageElement.appendChild(contentElement);

    messagesContainer.appendChild(messageElement);

    messagesContainer.scrollTop =
        messagesContainer.scrollHeight;

    return {
        messageElement,
        contentElement
    };
}


// ===============================
// UI STATE
// ===============================

function setGenerating(value) {

    isGenerating = value;

    messageInput.disabled = value;
    modelSelect.disabled = value;
    sendButton.disabled = value;
    newChatButton.disabled = value;

    stopButton.disabled = !value;
    thinkToggle.disabled = value;
    systemPromptInput.disabled = value;
    temperatureInput.disabled = value;
    contextSizeInput.disabled = value;
    imageInput.disabled = value || !supportsImageInput();
}


// ===============================
// MODEL DISCOVERY
// ===============================

async function loadModels() {

    try {

        const response =
            await fetch("/api/models");

        if (!response.ok) {
            throw new Error("Cannot load models");
        }

        const models = await response.json();

        modelSelect.innerHTML = "";

        modelCapabilities = {};

        models.forEach(model => {

            const option =
                document.createElement("option");

            option.value = model.name;
            option.textContent = model.name;

            modelSelect.appendChild(option);

            modelCapabilities[model.name] =
                model.capabilities;
        });

        if (models.length === 0) {
            throw new Error("No local models found");
        }

        updateThinkingControl();

        statusElement.textContent = "";

    } catch (error) {

        statusElement.textContent = error.message;

    }
}


// ===============================
// THINKING CONTROL
// ===============================

function updateThinkingControl() {

    const model = modelSelect.value;

    const capabilities =
        modelCapabilities[model] || [];

    const supportsThinking =
        capabilities.includes("thinking");

    thinkControl.hidden = !supportsThinking;

    if (!supportsThinking) {
        thinkToggle.checked = false;
    }

    // Image input is shown only when the selected model advertises vision.
    const supportsVision = capabilities.includes("vision");
    imageControl.hidden = !supportsVision;
    imageInput.disabled = isGenerating || !supportsVision;

    if (!supportsVision) {
        selectedImage = null;
        imageInput.value = "";
        imageStatus.textContent = "";
    }
}

function supportsImageInput() {
    return (modelCapabilities[modelSelect.value] || [])
        .includes("vision");
}

modelSelect.addEventListener(
    "change",
    updateThinkingControl
);

// Keep the displayed number in sync with the temperature slider.
temperatureInput.addEventListener("input", () => {
    temperatureValue.textContent = temperatureInput.value;
});

// Reflect the selected context window so users can compare its memory cost.
contextSizeInput.addEventListener("input", () => {
    contextSizeValue.textContent = contextSizeInput.value;
});

// Read selected files locally and keep the base64 payload for Ollama.
imageInput.addEventListener("change", () => {
    const file = imageInput.files?.[0];
    selectedImage = null;

    if (!file) {
        imageStatus.textContent = "";
        return;
    }

    if (!file.type.startsWith("image/")) {
        imageInput.value = "";
        imageStatus.textContent = "Choose an image file.";
        return;
    }

    if (file.size > 3 * 1024 * 1024) {
        imageInput.value = "";
        imageStatus.textContent = "Image must be 3 MB or smaller.";
        return;
    }

    const reader = new FileReader();
    reader.addEventListener("load", () => {
        if (typeof reader.result !== "string") {
            imageStatus.textContent = "Could not read this image.";
            return;
        }

        const [header, base64] = reader.result.split(",", 2);
        if (!base64 || !header.startsWith("data:image/")) {
            imageStatus.textContent = "Could not read this image.";
            return;
        }

        selectedImage = {
            base64,
            previewUrl: reader.result
        };
        imageStatus.textContent = `Attached: ${file.name}`;
    });
    reader.addEventListener("error", () => {
        imageStatus.textContent = "Could not read this image.";
    });
    reader.readAsDataURL(file);
});


// ===============================
// NDJSON STREAM READER
// ===============================

async function* readNDJSON(response) {

    const reader = response.body.getReader();

    const decoder = new TextDecoder();

    let buffer = "";

    while (true) {

        const { value, done } = await reader.read();

        if (done) {
            break;
        }

        buffer += decoder.decode(value, {
            stream: true
        });

        const lines = buffer.split("\n");

        // Keep incomplete line
        buffer = lines.pop();

        for (const line of lines) {

            if (line.trim() === "") {
                continue;
            }

            yield JSON.parse(line);
        }
    }

    // Flush remaining decoder data
    buffer += decoder.decode();

    // Parse the final line if it has no trailing newline
    if (buffer.trim() !== "") {
        yield JSON.parse(buffer);
    }
}


// ===============================
// SEND MESSAGE
// ===============================

async function sendMessage(text, image = null) {

    if (isGenerating || (!text.trim() && !image)) {
        return;
    }

    const model = modelSelect.value;

    if (!model) {
        statusElement.textContent =
            "Please select a model.";

        return;
    }

    statusElement.textContent = "";

    // Add user message to history
    const userMessage = {
        role: "user",
        content: text
    };

    if (image) {
        userMessage.images = [image.base64];
    }
    history.push(userMessage);

    // Display user message
    const userUI = addMessage("user", text);
    if (image) {
        const imagePreview = document.createElement("img");
        imagePreview.className = "message-image";
        imagePreview.src = image.previewUrl;
        imagePreview.alt = "Attached image";
        userUI.messageElement.insertBefore(
            imagePreview,
            userUI.contentElement
        );
    }

    // Create assistant message placeholder
    const assistantUI =
        addMessage("assistant", "");

    const {
        messageElement,
        contentElement
    } = assistantUI;

    // Reasoning display
    const thinkingElement =
        document.createElement("details");

    thinkingElement.className = "thinking";

    const thinkingSummary =
        document.createElement("summary");

    thinkingSummary.textContent =
        "Reasoning";

    const thinkingContent =
        document.createElement("div");

    thinkingContent.className = "message-content";

    thinkingElement.appendChild(thinkingSummary);
    thinkingElement.appendChild(thinkingContent);

    // Generation statistics
    const statsElement =
        document.createElement("div");

    statsElement.className = "stats";

    // Assistant content comes after reasoning
    messageElement.insertBefore(
        thinkingElement,
        contentElement
    );

    messageElement.appendChild(statsElement);

    let answer = "";
    let reasoning = "";

    setGenerating(true);

    activeController = new AbortController();

    try {

        const supportsThinking =
            (modelCapabilities[model] || [])
                .includes("thinking");

        const requestBody = {
            model,
            messages: history,
            stream: true,
            systemPrompt: systemPromptInput.value,
            temperature: Number(temperatureInput.value),
            numCtx: Number(contextSizeInput.value)
        };

        if (supportsThinking) {
            requestBody.think = thinkToggle.checked;
        }

        const response = await fetch("/api/chat", {

            method: "POST",

            headers: {
                "Content-Type": "application/json"
            },

            body: JSON.stringify(requestBody),

            signal: activeController.signal

        });

        if (!response.ok) {

            const errorData = await response.json();

            throw new Error(
                errorData.error || "Request failed"
            );
        }

        // Read the NDJSON stream
        for await (const chunk of readNDJSON(response)) {

            if (chunk.error) {
                throw new Error(chunk.error);
            }

            if (chunk.message?.thinking) {

                reasoning += chunk.message.thinking;

                thinkingContent.textContent = reasoning;

                thinkingElement.hidden = false;
            }

            if (chunk.message?.content) {

                answer += chunk.message.content;

                contentElement.textContent = answer;

                messagesContainer.scrollTop =
                    messagesContainer.scrollHeight;
            }

            // Final chunk: generation statistics
            if (chunk.done) {

                const tokens = chunk.eval_count;

                const duration = chunk.eval_duration;

                if (tokens && duration) {

                    const tokensPerSecond =
                        tokens / (duration / 1_000_000_000);

                    statsElement.textContent =
                        `${tokens} tokens · ` +
                        `${tokensPerSecond.toFixed(2)} tokens/s`;
                }
            }
        }

        // Save assistant response in conversation history
        history.push({
            role: "assistant",
            content: answer
        });

    } catch (error) {

        if (error.name === "AbortError") {

            // Stop is intentional.
            // Keep partial answer in history.

            if (answer) {

                history.push({
                    role: "assistant",
                    content: answer
                });

            }

            statusElement.textContent =
                "Generation stopped.";

        } else {

            // Remove the unanswered user message
            if (history.at(-1)?.role === "user") {
                history.pop();
            }

            messageElement.remove();

            statusElement.textContent =
                error.message;

            console.error(error);
        }

    } finally {

        activeController = null;

        setGenerating(false);

        messageInput.focus();
    }
}


// ===============================
// FORM SUBMISSION
// ===============================

chatForm.addEventListener(
    "submit",
    async event => {

        event.preventDefault();

        const text = messageInput.value.trim();
        const image = selectedImage;

        if ((!text && !image) || isGenerating) {
            return;
        }

        messageInput.value = "";
        selectedImage = null;
        imageInput.value = "";
        imageStatus.textContent = "";

        await sendMessage(text, image);
    }
);


// ===============================
// STOP GENERATION
// ===============================

stopButton.addEventListener("click", () => {

    if (activeController) {

        activeController.abort();

    }

});


// ===============================
// NEW CHAT
// ===============================

newChatButton.addEventListener("click", () => {

    if (isGenerating) {
        return;
    }

    history = [];

    messagesContainer.innerHTML = "";

    const welcome =
        document.createElement("div");

    welcome.className = "welcome";

    const heading =
        document.createElement("h2");

    heading.textContent = "New conversation";

    const paragraph =
        document.createElement("p");

    paragraph.textContent =
        "Ask your local AI assistant anything.";

    welcome.appendChild(heading);
    welcome.appendChild(paragraph);

    messagesContainer.appendChild(welcome);

    statusElement.textContent = "";

});


// ===============================
// INITIALIZATION
// ===============================

loadModels();
