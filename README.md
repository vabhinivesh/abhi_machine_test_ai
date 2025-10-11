# CPQ Agent for Industrial Pumps

An AI-powered Configure-Price-Quote (CPQ) system for industrial pumps using Temporal workflows and ReAct agents.

## Features

- **Interactive Requirements Gathering**: AI agent asks clarifying questions to understand customer needs
- **Intelligent Configuration**: Automatically selects optimal pump configuration based on requirements
- **Rule-Based Validation**: Enforces business rules (ATEX compliance, voltage/HP limits, etc.)
- **Dynamic Pricing**: Generates detailed BOM and pricing with configurable discounts
- **Temporal Workflows**: Durable execution with state management and recovery

## Prerequisites

- **Node.js**: v18 or higher
- **npm**: v8 or higher
- **Docker** (optional): For running Temporal server locally
- **AI Provider**: One of the following:
  - OpenAI API key
  - Ollama (local installation)

## Project Setup

### 1. Clone and Install Dependencies

```bash
# Clone the repository
cd abhi_machine_test_ai

# Install dependencies
npm install

# Rebuild native modules (required for Temporal on Windows)
npm rebuild @temporalio/core-bridge
```

### 2. Configure Environment Variables

Create a `.env` file from the example:

```bash
cp .env.example .env
```

Edit `.env` and configure your AI provider:

#### Option A: Using OpenAI

```env
AI_PROVIDER=openai
OPENAI_API_KEY=sk-your-actual-api-key-here
OPENAI_MODEL=gpt-4o-mini
```


#### Option B: Using Ollama (Local)

```env
AI_PROVIDER=ollama
OLLAMA_HOST=http://localhost:11434
OLLAMA_MODEL=qwen3:8b
```


### 3. Set Up Temporal (Optional)

For full workflow functionality, you need a Temporal server:

#### Using Docker Compose (Recommended)

```bash
# Start Temporal server
npm run temporal

# View logs
npm run temporal:logs

# Stop Temporal server
npm run temporal:stop
```

#### Using Temporal Cloud

Update `.env` with your Temporal Cloud credentials:
```env
TEMPORAL_ADDRESS=your-namespace.tmprl.cloud:7233
```

## Running the Application

### Interactive CLI Mode

Start the interactive quote generation:

```bash
npm start
```

This will:
1. Ask for customer information
2. Gather pump requirements through AI-powered conversation
3. Generate configuration and pricing
4. Save the quote to `runs/` directory

### Running Tests

```bash
# Run all tests
npm test

# Run specific test file
npm test scenarios-unit.test.ts

# Run tests in watch mode
npm test:watch
```

### Test Scenarios

The project includes three validated scenarios:

- **S1 - Small, budget**: 40 GPM @ 60 ft, 230V_1ph → P100, 3 HP, $1,412
- **S2 - Medium, low maintenance**: 75 GPM @ 100 ft, 460V_3ph → P100, 5 HP, $1,908
- **S3 - ATEX environment**: 120 GPM @ 150 ft, ATEX → P200, 10 HP, $4,332

## Project Structure

```
├── src/
│   ├── activities/          # Temporal activities
│   │   └── quote.activities.ts
│   ├── agent/              # ReAct agent implementation
│   │   ├── react-agent.ts
│   │   ├── tool-schemas.ts
│   │   └── tools.ts
│   ├── cli/                # Command-line interface
│   │   └── interactive-quote.ts
│   ├── data/               # Data loaders
│   │   └── loaders.ts
│   ├── models/             # TypeScript types
│   │   └── types.ts
│   └── workflows/          # Temporal workflows
│       └── quote.workflow.ts
├── data/                   # Configuration data
│   ├── catalog.csv         # Pump family specifications
│   ├── flow_head_map.csv   # Flow/head to pump mapping
│   ├── bom_rules.json      # Bill of materials rules
│   ├── pricing_rules.json  # Pricing configuration
│   └── prompts/            # AI prompt templates
├── tests/                  # Test files
│   ├── scenarios-unit.test.ts
│   └── catalog.test.ts
└── runs/                   # Generated quotes (created automatically)
```

## Configuration Files

### `data/catalog.csv`
Defines pump families with specifications (GPM range, max head, max HP).

### `data/flow_head_map.csv`
Maps flow rate and head requirements to specific pump configurations.

### `data/bom_rules.json`
Defines component pricing and BOM generation rules.

### `data/pricing_rules.json`
Sets default discount percentage and pricing policies.

## Development

### Build TypeScript

```bash
npm run build
```

### Run Worker (for Temporal workflows)

```bash
npm run worker
```

### Run Both Worker and CLI

```bash
npm run dev
```

## Troubleshooting

### Native Module Errors (Windows)

If you encounter errors with `@temporalio/core-bridge`:

```bash
npm rebuild @temporalio/core-bridge
```

### Temporal Connection Issues

Ensure Temporal server is running:
```bash
docker ps | grep temporal
```

If not running:
```bash
npm run temporal
```

### AI Provider Errors

- **OpenAI**: Verify API key is valid and has credits
- **Ollama**: Ensure Ollama service is running (`ollama serve`)

## License

MIT

## Support

For issues or questions, please open an issue in the repository.
