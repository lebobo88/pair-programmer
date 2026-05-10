# Software Development Taxonomy Blueprint

**Purpose**: Define the full set of decisions, artifacts, ownership models, and operating controls a product and development organization must establish to build, ship, operate, and retire software well.

**Scope stance**: General-purpose by default, with explicit deviations for non-UI products, UI-heavy products, APIs/platforms, internal tools, enterprise/regulated systems, AI/agentic systems, mobile apps, developer platforms/SDKs, data/analytics products, and embedded/edge contexts.

**Audience**: Product, design, engineering, architecture, QA, security, privacy, compliance, operations, support, delivery/program management, and executive sponsors.

**How to use this document**
1. Use Sections 1-4 to define the blueprint.
2. Use Sections 5-7 to stress-test completeness.
3. Use Section 8 as the template for a project-specific master plan.
4. Treat every domain here as a first-class workstream, not as "documentation overhead."

## 1. Executive synthesis

Most teams under-specify software because they reduce planning to a narrow chain:

`idea -> requirements -> design -> code -> test -> launch`

That chain is incomplete. High-performing delivery requires coordinated decisions across:

- business outcomes and investment logic,
- user and domain understanding,
- product scope and success criteria,
- UX/UI/content and accessibility,
- domain/data/analytics semantics,
- architecture and technical strategy,
- API/event/integration contracts,
- engineering standards and implementation patterns,
- security/privacy/compliance and trust,
- testing and verification,
- environments, delivery, release, and change control,
- observability, reliability, and support,
- documentation and enablement,
- team operating model and decision governance,
- AI-specific controls where applicable,
- deprecation and retirement planning.

The key principle is simple: **software quality is the emergent result of aligned decisions across the full lifecycle, not the output of coding alone**. This view is consistent with delivery and reliability research from DORA, secure development guidance from NIST SSDF, application security verification guidance from OWASP ASVS, accessibility guidance from W3C/WCAG, architectural documentation practices such as ADR and C4, interface standards such as OpenAPI and AsyncAPI, and supply-chain integrity frameworks such as SLSA and SBOM ecosystems [DORA 2025], [NIST SSDF], [OWASP ASVS], [WCAG], [OpenAPI], [AsyncAPI], [C4], [SLSA], [NTIA SBOM].

The practical implication:

- Every major requirement should have an owner.
- Every owner should have a durable artifact.
- Every artifact should have downstream consumers.
- Every critical dependency should have a review gate.
- Every gate should have an explicit exit criterion.
- Every shipped system should already include an operations and retirement story.

## 2. Confidence ratings

| Section | Confidence | Why |
|---|---|---|
| Core lifecycle taxonomy | High | Strong convergence across product practice, architecture practice, delivery research, and secure SDLC frameworks |
| Security, privacy, supply chain, and compliance | High | Anchored in mature standards and control families such as NIST SSDF, OWASP ASVS, ISO 27001, SLSA, SBOM |
| UX/accessibility/content completeness | High | Strong standards basis in W3C/WCAG and established product design practice |
| Team operating model and governance | Medium-High | High practical confidence, but exact governance depth is organization-specific |
| Project-type deviations | Medium-High | Strong patterns exist, but tradeoffs vary by business model, regulation, and system criticality |
| AI/agentic controls | Medium | Strong emerging guidance from NIST AI RMF and operational practice, but norms are still moving faster than classic SDLC domains |
| Master planning document structure | High | Stable synthesis of widely used planning, architecture, quality, and governance artifacts |

## 3. Taxonomy at a glance

1. Strategy, business context, and investment logic
2. User, market, workflow, and domain understanding
3. Product scope, requirements, and prioritization
4. Experience design, content, and accessibility
5. Domain model, data, analytics, and information lifecycle
6. Architecture and technical strategy
7. Interfaces, contracts, and integration wiring
8. Engineering implementation system and code quality
9. Security, privacy, compliance, and trust
10. Quality engineering and verification
11. Delivery, environments, release, and change management
12. Observability, reliability, operations, and support
13. Documentation, enablement, and knowledge management
14. Team operating model, decision governance, and execution cadence
15. AI and agentic system controls
16. Deprecation, retirement, and lifecycle exit

## 4. Detailed taxonomy

### 4.1 Strategy, business context, and investment logic

**What must be understood or decided**
- What business outcome the software exists to change
- Who pays, who benefits, and who bears operational risk
- Market position, differentiation, and timing
- Commercial model: revenue, cost reduction, risk reduction, enablement, compliance, or platform leverage
- Success metrics, guardrail metrics, and kill criteria
- Portfolio priority versus other initiatives

**Typical artifacts**
- Vision brief
- Business case
- Product strategy memo
- OKRs / outcome scorecard
- Portfolio roadmap
- Assumption log
- Risk register

**Common owners and collaborators**
- Executive sponsor
- GM / business owner
- Product lead
- Finance
- Strategy / operations
- Engineering leadership

**Downstream consumers**
- PRD and scope decisions
- Staffing and budget plans
- Architecture choices
- Support model
- Sales / enablement narratives

**Failure modes if under-specified**
- Feature factory behavior
- Local optimization without measurable value
- Constant reprioritization
- Architecture overbuilt for the wrong business need
- No clear launch or stop criteria

**Key subdomains**
- Outcome model
- Value chain and stakeholder economics
- Portfolio placement
- Constraints and non-negotiables
- Risk appetite and governance posture

### 4.2 User, market, workflow, and domain understanding

**What must be understood or decided**
- Target users, operators, admins, buyers, and approvers
- User jobs, pains, constraints, and context of use
- Current workflow, adjacent systems, and handoffs
- Domain language, rules, and edge conditions
- Research confidence and unresolved assumptions

**Typical artifacts**
- Research brief
- Persona / role model
- Jobs-to-be-done summary
- Journey maps
- Service blueprint
- Workflow maps
- Domain glossary
- Competitive / comparative analysis

**Common owners and collaborators**
- Product manager
- UX researcher
- Design lead
- Domain SME
- Customer success / support
- Sales / solutions

**Downstream consumers**
- Feature specs
- UX flows
- Domain model
- Analytics taxonomy
- Support scripts
- Documentation

**Failure modes if under-specified**
- Wrong problem chosen
- Good implementation of a low-value workflow
- Misnamed concepts that confuse users and engineers
- Hidden approval or exception paths discovered late

**Key subdomains**
- Stakeholder map
- Workflow and service interactions
- Domain semantics
- Research evidence quality
- Adoption barriers

### 4.3 Product scope, requirements, and prioritization

**What must be understood or decided**
- Product boundaries and excluded scope
- Functional requirements
- Acceptance criteria
- Business rules and invariants
- Non-functional requirements
- Prioritization model and delivery phases
- Dependencies, rollout assumptions, and sunset assumptions

**Typical artifacts**
- PRD
- Feature specifications
- User stories / use cases
- Acceptance criteria
- Roadmap
- Backlog
- Requirements traceability map
- Change log

**Common owners and collaborators**
- Product manager
- Tech lead
- Design lead
- QA lead
- Security / compliance for constrained domains

**Downstream consumers**
- Architecture and API design
- Test planning
- Estimation and staffing
- Release planning
- Customer communications

**Failure modes if under-specified**
- Scope creep
- Conflicting assumptions across teams
- Missing edge cases
- Late discovery of performance, regulatory, or operational constraints
- "Done" means different things to different teams

**Key subdomains**
- Functional requirements
- Non-functional requirements
- Constraints and assumptions
- Priority and sequencing
- Definition of done

### 4.4 Experience design, content, and accessibility

**What must be understood or decided**
- Information architecture and navigation model
- User flows, task paths, and interruption handling
- Screen / interaction states: default, hover, focus, active, loading, empty, error, disabled
- Content strategy, nomenclature, and microcopy
- Visual system, component model, and design tokens
- Accessibility requirements, localization needs, and responsive behavior
- Onboarding, help surfaces, and recovery UX

**Typical artifacts**
- IA map
- User flow diagrams
- Wireframes
- Mockups
- Prototypes
- Design system
- Component specs
- Design tokens
- Content style guide
- Accessibility checklist
- Localization plan

**Common owners and collaborators**
- Product designer
- Content designer
- Frontend lead
- Accessibility specialist
- Product manager
- UX researcher

**Downstream consumers**
- Frontend implementation
- QA and accessibility testing
- Localization
- Support and training
- Analytics instrumentation

**Failure modes if under-specified**
- Beautiful but unusable flows
- Inconsistent UI states
- Accessibility failures found late
- Localization breakage
- Content debt and support burden
- UI stubs that never get fully wired to live behavior

**Key subdomains**
- IA and wayfinding
- State design
- Empty/error/help experiences
- Permission-aware UX
- Accessibility and inclusion
- Content and localization

### 4.5 Domain model, data, analytics, and information lifecycle

**What must be understood or decided**
- Canonical entities and relationships
- Source of truth for each data domain
- State transitions and lifecycle rules
- Event model and audit history
- Analytics definitions and business metric semantics
- Data quality, retention, deletion, archival, and migration rules
- Privacy classification and lineage

**Typical artifacts**
- Domain model
- ERD / logical data model
- Data dictionary
- Schema registry
- Event catalog
- Data lineage map
- Analytics event taxonomy
- Retention and deletion policy
- Migration / backfill plan

**Common owners and collaborators**
- Architect
- Backend lead
- Data lead
- Analytics lead
- Privacy / legal
- Product manager

**Downstream consumers**
- APIs and services
- Reporting
- ML / AI systems
- Compliance and audit
- Support investigations
- Migration and rollback planning

**Failure modes if under-specified**
- Conflicting definitions of core concepts
- Broken analytics and impossible KPI trust
- Data sprawl
- Inability to prove deletion, retention, or provenance
- Dangerous migrations and brittle backfills

**Key subdomains**
- Operational data
- Analytical data
- Event data
- Lineage and provenance
- Retention and deletion
- Data contracts and migrations

### 4.6 Architecture and technical strategy

**What must be understood or decided**
- System boundaries and decomposition
- Runtime topology and deployment model
- Synchronous versus asynchronous interactions
- Scalability, latency, availability, and resilience objectives
- Buy versus build versus integrate choices
- Tech stack, framework, and platform strategy
- Architectural decision records and fitness criteria

**Typical artifacts**
- System context diagram
- C4 diagrams
- Architecture overview
- ADRs
- Tech stack document
- Deployment architecture
- Reliability model
- Cost/performance model

**Common owners and collaborators**
- Architect
- Principal / staff engineer
- Platform lead
- Security
- Product lead

**Downstream consumers**
- Implementation plans
- Environment design
- Incident response
- Capacity and cost management
- Vendor selection

**Failure modes if under-specified**
- Architecture drift
- Accidental tight coupling
- Unowned complexity
- Hidden runtime assumptions
- Scalability or resilience surprises in production

**Key subdomains**
- Context/container/component/code views [C4]
- Coupling and boundaries
- Reliability patterns
- Cost/performance tradeoffs
- Tenancy and isolation
- Architecture governance

### 4.7 Interfaces, contracts, and integration wiring

**What must be understood or decided**
- HTTP API, route, RPC, event, and webhook contracts
- Versioning and compatibility model
- Authentication, authorization, rate limiting, idempotency, and retry semantics
- Error contracts and operational status surfaces
- Frontend-backend interface boundaries
- Third-party dependency contracts and SLAs
- Import/export, sync, and data-mapping rules

**Typical artifacts**
- OpenAPI specification [OpenAPI]
- AsyncAPI specification [AsyncAPI]
- Route inventory
- Event catalog
- Interface control document
- Contract test suite
- Sequence diagrams
- Integration matrix
- Permission matrix

**Common owners and collaborators**
- API lead
- Backend lead
- Frontend lead
- Integration engineer
- Partner / platform engineering
- QA

**Downstream consumers**
- Client apps
- External integrators
- QA automation
- SDKs and generated clients
- Support and incident diagnostics

**Failure modes if under-specified**
- Stubs do not match production behavior
- Breaking changes without notice
- Ambiguous errors and retries
- Frontend wires to assumptions rather than contracts
- Partner integrations break on edge cases

**Key subdomains**
- Request/response contracts
- Event schemas
- Route ownership
- Backward compatibility
- Error and retry semantics
- Integration observability

### 4.8 Engineering implementation system and code quality

**What must be understood or decided**
- Repository and module structure
- Coding standards, naming, and review norms
- Local development model
- Dependency and package policy
- Configuration and secret-handling patterns
- Scaffolding, templates, and codegen rules
- Branching, merge, and release practices

**Typical artifacts**
- Engineering handbook
- Coding standards / constitution
- Lint and formatting rules
- Repository conventions
- Architecture guardrails
- Template library
- Dependency policy
- Code review checklist

**Common owners and collaborators**
- Engineering leadership
- Staff engineers
- DX / platform
- Security
- All service owners

**Downstream consumers**
- Daily implementation work
- Onboarding
- Automation and code generation
- Review quality
- Maintainability and refactoring

**Failure modes if under-specified**
- High variance across codebases
- Reviewer inconsistency
- Slow onboarding
- Secret leakage or config drift
- Frontend and backend patterns diverge until integration pain appears

**Key subdomains**
- Module boundaries
- Conventions and standards
- Secrets and configuration
- Code review and merge policy
- Dev environment and tooling
- Definition of done

### 4.9 Security, privacy, compliance, and trust

**What must be understood or decided**
- Threat model and trust boundaries
- Authn/authz model and least-privilege expectations
- Data classification and privacy obligations
- Secure development lifecycle activities [NIST SSDF], [OWASP SAMM]
- Verification requirements [OWASP ASVS]
- Regulatory, contractual, and audit expectations
- Supply-chain integrity, provenance, and bill-of-materials requirements [SLSA], [NTIA SBOM], [SPDX], [CycloneDX]

**Typical artifacts**
- Threat model
- Data classification policy
- Privacy impact assessment
- Auth model
- Control matrix
- Secure coding standard
- Security review checklist
- Vendor risk assessment
- SBOM
- Provenance and build integrity targets
- Incident response plan

**Common owners and collaborators**
- Security
- Privacy / legal
- Architecture
- Platform
- Compliance
- Service owners

**Downstream consumers**
- Engineering
- Procurement
- Audit
- Sales / security review
- Incident response

**Failure modes if under-specified**
- Late security redesign
- Failed enterprise deals
- Unprovable controls
- Overbroad permissions
- Data handling that violates policy or law
- Untracked third-party and build risks

**Key subdomains**
- Threat modeling
- IAM and authorization
- Secure SDLC and vulnerability management
- Privacy and data minimization [NIST Privacy Framework]
- Auditability
- Supply chain and provenance

### 4.10 Quality engineering and verification

**What must be understood or decided**
- Quality model and acceptable risk
- Test strategy by level: unit, integration, contract, end-to-end, non-functional
- Ownership of acceptance testing
- Environment fidelity and test data strategy
- Accessibility, performance, reliability, and security testing
- Release-readiness criteria and defect triage

**Typical artifacts**
- Test strategy
- Test plan
- Acceptance test suite
- Contract tests
- E2E test specs
- Performance budget
- Accessibility audit checklist
- Security test plan
- Release checklist

**Common owners and collaborators**
- QA / SDET
- Engineering
- Product
- Design
- Security
- Operations

**Downstream consumers**
- CI/CD gates
- Release approvals
- Incident prevention
- Audit evidence
- Support readiness

**Failure modes if under-specified**
- Happy-path-only validation
- Flaky releases
- Accessibility and performance surprises
- No agreement on what blocks launch
- Inability to prove the product behaves as specified

**Key subdomains**
- Test pyramid
- Contract verification
- NFR verification
- UAT and sign-off
- Test data and fixtures
- Release criteria

### 4.11 Delivery, environments, release, and change management

**What must be understood or decided**
- Environment model and promotion path
- CI/CD design
- Infrastructure as code and configuration management
- Release strategy: dark launch, canary, phased rollout, blue/green
- Rollback and kill-switch strategy
- Schema migration and backfill choreography
- Change control, approvals, and communications

**Typical artifacts**
- Environment matrix
- Deployment pipeline configuration
- IaC
- Release plan
- Rollback plan
- Migration runbook
- Feature flag plan
- Change record
- Launch checklist

**Common owners and collaborators**
- Platform / DevOps
- Release manager
- Service owners
- DBA / data engineer
- Security
- Support

**Downstream consumers**
- Engineering teams
- Support and customer success
- Audit
- Incident response
- Enterprise customers with change sensitivity

**Failure modes if under-specified**
- Unsafe deploys
- Config drift
- Irreversible migrations
- Noisy launches with poor communications
- Release gates decided ad hoc

**Key subdomains**
- Build and promotion
- Environment parity
- Feature flags and config
- Migrations and compatibility
- Rollback and contingency
- Change communications

### 4.12 Observability, reliability, operations, and support

**What must be understood or decided**
- SLIs, SLOs, and error budgets
- Logging, metrics, tracing, and correlation standards
- Alert strategy and noise thresholds
- On-call model and support escalation
- Runbooks, incident playbooks, and status communications
- Capacity, cost, and resilience review cadence

**Typical artifacts**
- Observability specification
- Telemetry taxonomy
- Dashboard inventory
- Alert catalog
- SLO document
- Runbooks
- Incident playbooks
- Support SOPs
- Service review deck

**Common owners and collaborators**
- SRE / ops
- Service owners
- Support
- Product
- Data / analytics

**Downstream consumers**
- Incident response
- Reliability improvement work
- Executive reporting
- Customer support
- Roadmap prioritization

**Failure modes if under-specified**
- Blind operations
- Alert fatigue
- Ambiguous incident ownership
- Recurring failures with no learning loop
- High support burden because telemetry lacks product context

**Key subdomains**
- Monitoring and telemetry
- Reliability targets
- Incident management
- Support readiness
- Capacity and cost operations
- Continuous improvement

### 4.13 Documentation, enablement, and knowledge management

**What must be understood or decided**
- Source-of-truth locations
- Doc audiences and access patterns
- Ownership and update expectations
- User-facing documentation needs
- Internal operational documentation needs
- Release notes, onboarding, and training expectations

**Typical artifacts**
- Internal wiki / handbook
- User docs
- API docs
- Runbooks
- Onboarding guides
- ADR log
- FAQ / knowledge base
- Release notes
- Deprecation notices

**Common owners and collaborators**
- Product
- Tech writers
- DX
- Engineering
- Support
- Training / enablement

**Downstream consumers**
- Users
- Integrators
- New hires
- Support
- Auditors

**Failure modes if under-specified**
- Tribal knowledge dominates
- Support volume rises
- New engineers move slowly
- Customers cannot self-serve
- Changes land with no durable explanation

**Key subdomains**
- Internal knowledge
- External docs
- Operational docs
- Training and onboarding
- Change communication

### 4.14 Team operating model, decision governance, and execution cadence

**What must be understood or decided**
- Role boundaries and accountability
- Decision rights and escalation model
- Planning, review, and delivery cadences
- Dependency management
- Risk governance
- Vendor and external dependency governance
- Launch and incident command models

**Typical artifacts**
- Operating model
- RACI
- Governance calendar
- Decision log
- Review board outputs
- Delivery plan
- Risk register
- Dependency map

**Common owners and collaborators**
- Product leadership
- Engineering leadership
- Design leadership
- Security / compliance
- Program / delivery management
- Operations leadership

**Downstream consumers**
- Entire program
- External stakeholders
- Audit and compliance
- Support and customer-facing teams

**Failure modes if under-specified**
- Work falls between teams
- Decisions stall or are revisited endlessly
- Dependencies surface late
- Launches fail due to coordination, not code
- Post-incident learning never changes behavior

**Key subdomains**
- Role model
- Decision forums
- Planning cadence
- Review gates
- Dependency management
- Escalation paths

### 4.15 AI and agentic system controls

**What must be understood or decided**
- Whether AI is core, assistive, optional, or prohibited for a workflow
- Model selection and fallback policy
- Prompt, tool, memory, and context boundaries
- Retrieval / grounding strategy
- Evaluation methodology, confidence handling, and human review requirements
- Safety, misuse, privacy, and data-egress controls
- Model lifecycle, observability, and drift handling

**Typical artifacts**
- AI system specification
- Model selection rationale
- Prompt / policy registry
- Eval suite
- Guardrail policy
- Tool permission matrix
- HITL workflow
- Red-team plan
- Incident playbook for model misbehavior

**Common owners and collaborators**
- AI lead
- Product manager
- Security / privacy
- Platform
- QA
- Legal / compliance

**Downstream consumers**
- Application teams
- Support
- Risk and audit
- Security review
- Customer trust / procurement

**Failure modes if under-specified**
- Hallucinations reach production without mitigation
- Prompt drift changes behavior invisibly
- Unsafe tool execution
- Sensitive data leaks to models or logs
- No reproducible explanation for outcomes

**Key subdomains**
- Model and prompt governance
- Tooling permissions
- Grounding and retrieval
- Evaluation and monitoring
- Human oversight
- Data governance for AI

### 4.16 Deprecation, retirement, and lifecycle exit

**What must be understood or decided**
- Exit criteria for features, APIs, and systems
- Migration timelines and compatibility windows
- Data export, archival, deletion, and record-keeping obligations
- User and integrator communications
- Operational shutdown plan and residual risk ownership

**Typical artifacts**
- Deprecation policy
- EOL plan
- Migration guide
- Archive and retention plan
- Customer notice template
- Shutdown checklist

**Common owners and collaborators**
- Product
- Engineering
- Support
- Legal / compliance
- Operations

**Downstream consumers**
- Customers and integrators
- Support
- Finance
- Audit
- Operations

**Failure modes if under-specified**
- Zombie systems never retired
- Permanent support burden
- Contractual or retention breaches
- Unexpected customer breakage

**Key subdomains**
- Version sunset
- Customer migration
- Data lifecycle closure
- Operational shutdown

## 5. Cross-functional artifact, owner, and dependency matrix

| Domain | Primary artifacts | Accountable owner | Primary consumers |
|---|---|---|---|
| Strategy and business | Vision, business case, OKRs, roadmap | Executive sponsor / product leadership | Product, engineering, finance |
| User and domain understanding | Research brief, journeys, glossary, workflows | Product + UX research | Product, design, architecture, support |
| Product scope and requirements | PRD, feature specs, acceptance criteria, backlog | Product manager | Design, engineering, QA, operations |
| UX/UI/content | Design system, flows, prototypes, content guide, tokens | Design lead | Frontend, QA, localization, support |
| Data and analytics | Domain model, schemas, lineage, event taxonomy, retention policy | Data / backend / architecture | APIs, analytics, compliance, AI |
| Architecture | C4 diagrams, ADRs, stack docs, deployment model | Architect / principal engineer | Engineering, platform, security, ops |
| Interfaces and integrations | OpenAPI, AsyncAPI, route maps, contract tests | API / integration lead | Clients, partners, QA, support |
| Engineering system | Standards, repo conventions, review checklists, templates | Engineering leadership | All engineers, DX, automation |
| Security/privacy/compliance | Threat model, control matrix, auth model, PIA, SBOM | Security / privacy / compliance | Engineering, audit, procurement, sales |
| Quality and verification | Test strategy, test plans, release checklist | QA / SDET lead | Engineering, release, support |
| Delivery and release | Pipeline config, IaC, rollout plan, rollback plan | Platform / DevOps / release | Engineering, ops, support, audit |
| Observability and support | SLOs, runbooks, alerts, support SOPs | SRE / service owner | Ops, support, product, leadership |
| Documentation and enablement | Internal docs, user docs, API docs, onboarding | Product + tech writing + DX | Users, new hires, support, partners |
| Team and governance | RACI, decision log, review outputs, delivery plan | Leadership + delivery | Entire program |
| AI controls | AI system spec, eval suite, prompt registry, HITL policy | AI lead + security + product | App teams, risk, support |
| Retirement | EOL plan, migration guide, archive policy | Product + engineering + ops | Customers, support, audit |

## 6. What teams most often miss

The following items are systematically under-specified, and they are usually discovered only during integration, launch, audit, or incident response:

1. **Non-functional requirements**: latency, throughput, availability, resilience, recovery time, recovery point, cost ceilings.
2. **Authorization model**: not just "users can log in," but which actors can do what, on which objects, under which conditions.
3. **Error, empty, loading, and recovery states**: especially in UI-heavy products.
4. **Workflow exceptions and manual overrides**: happy paths are rarely the operational truth.
5. **Data retention, deletion, and archival**: especially for enterprise, privacy-sensitive, and regulated data.
6. **Schema evolution and migration strategy**: including backfills, dual writes, rollback compatibility, and observability during migration.
7. **Analytics instrumentation semantics**: event names, business metric definitions, experiment exposure rules, data lineage.
8. **Operational ownership after launch**: who owns incidents, dashboards, support escalations, and service review.
9. **Feature flag lifecycle**: flags are often added but not governed, observed, or retired.
10. **Rollout and reversibility**: canary, staged release, kill switches, rollback, and customer communication.
11. **Test data management**: how realistic data is provisioned, masked, refreshed, and versioned.
12. **Third-party failure modes**: outages, quota limits, rate limits, contract changes, revoked credentials, bad data.
13. **Documentation ownership**: who updates runbooks, API docs, migration guides, and release notes.
14. **Supportability requirements**: searchable audit trails, correlation IDs, user-visible diagnostic states, admin tools.
15. **Accessibility and localization**: too often treated as polish rather than core product behavior [WCAG].
16. **Security review timing**: threat modeling and control mapping are often left until near launch [NIST SSDF], [OWASP SAMM].
17. **Supply-chain integrity**: SBOM, dependency governance, provenance, and artifact trust are often absent until procurement or audit asks [SLSA], [NTIA SBOM].
18. **Deprecation and sunset plan**: systems are launched with no plan for retirement.
19. **Decision logging**: teams discuss tradeoffs but do not preserve why decisions were made.
20. **AI evals and human review rules**: teams prototype quickly but ship without stable evaluation baselines or escalation paths [NIST AI RMF].

## 7. Project-type deviations and extra controls

| Project type | What rises in importance | Extra artifacts or controls | Common traps |
|---|---|---|---|
| Non-UI products (CLI, jobs, services) | Workflow automation, scheduling, failure handling, observability, operability | Runbooks, job semantics, retry policy, operational dashboards, CLI contract docs | Assuming no UI means no UX; ignoring operator experience and failure recovery |
| UI-heavy products | IA, interaction states, accessibility, content, client performance, frontend-backend wiring | Design system, token library, screen-state specs, accessibility test plan, route/state map | Pretty screens with incomplete states or broken real-data wiring |
| APIs and platforms | Contract stability, versioning, auth, rate limits, SDK consistency, partner support | OpenAPI/AsyncAPI, compatibility policy, contract tests, changelog, migration guide | Undocumented breaking changes and ambiguous errors |
| Internal tools | Workflow fit, permissions, auditability, admin ergonomics, low-maintenance delivery | Stakeholder maps, admin UX specs, audit log design, support SOPs | Treating internal users as tolerant of poor UX or weak reliability |
| Enterprise / regulated systems | Control evidence, privacy, retention, audit trails, approvals, segregation of duties | Control matrix, PIA/DPIA, audit logging spec, retention schedule, review gates, vendor risk file | Building first and mapping controls later |
| AI / agentic systems | Eval quality, grounding, tool permissions, HITL, data egress, model drift | AI system spec, eval suite, prompt registry, tool policy, confidence thresholds, fallback matrix | Shipping demos with no reproducible quality or safety envelope |
| Mobile / native apps | Offline behavior, device permissions, app-store release flow, client telemetry, upgrade compatibility | Mobile state matrix, offline sync design, permission UX, crash reporting plan, store rollout plan | Designing as if mobile were just a smaller web page |
| Developer platforms / SDKs | API ergonomics, docs, examples, version policy, compatibility guarantees | SDK design guide, sample apps, reference architecture, semantic versioning policy, deprecation policy | Underinvesting in docs and examples compared with core implementation |
| Data / analytics products | Semantics, lineage, freshness, reconciliation, governance, access control | Metric dictionary, lineage map, freshness SLAs, data quality checks, reconciliation plan | Teams argue over dashboards because terms were never standardized |
| Embedded / edge / OT | Intermittent connectivity, safety, device lifecycle, firmware update risk, physical constraints | Device lifecycle model, fleet update plan, failure-safe policy, edge observability spec | Applying cloud-only assumptions to constrained or safety-sensitive environments |

## 8. Team operating model and governance

### 8.1 Core roles and decision rights

| Role | Accountable for | Must co-own with |
|---|---|---|
| Executive sponsor | Outcome, funding, escalation, portfolio priority | Product leadership, engineering leadership |
| Product lead / PM | Scope, requirements, prioritization, launch goals | Design, engineering, QA, support |
| Design lead | UX, IA, content, accessibility, design system | Product, frontend, research |
| Architect / principal engineer | System shape, ADRs, technical risk, cross-cutting constraints | Product, platform, security |
| Engineering manager / team lead | Execution capacity, delivery health, team ownership | PM, architect, QA |
| QA / SDET lead | Verification strategy, quality gates, release evidence | Product, engineering, operations |
| Platform / DevOps / SRE | CI/CD, environments, reliability, observability, incident readiness | Engineering, security, support |
| Security / privacy / compliance | Threats, controls, data handling, assurance evidence | Architecture, product, platform, legal |
| Data / analytics lead | Data semantics, telemetry, reporting trust, governance | Product, engineering, privacy |
| Support / success lead | Operational support model, escalation readiness, user feedback loops | Product, ops, docs |
| Program / delivery manager | Cadence, dependency management, cross-team risk | All functional leads |
| AI lead (if applicable) | Model governance, evals, prompt/tool controls, HITL | Product, security, platform, QA |

### 8.2 Mandatory governance forums

| Forum | Typical cadence | Required outputs | Exit criteria |
|---|---|---|---|
| Problem framing / discovery review | Start of initiative | Problem statement, user evidence, success metrics | Clear value, target users, measurable outcome |
| Scope and requirements review | Before design lock | PRD, feature specs, acceptance criteria, NFRs | Scope boundaries and acceptance criteria approved |
| Design review | Before implementation | Flows, states, component specs, accessibility notes | UX complete for intended scope, not just happy path |
| Architecture review | Early and at major deltas | C4 views, ADRs, topology, reliability assumptions | Major technical risks and tradeoffs recorded |
| API / contract review | Before dependent teams build | OpenAPI/AsyncAPI, route/event map, versioning rules | Interfaces stable enough for parallel work |
| Threat / privacy review | Before build and before launch | Threat model, auth model, control mapping, data handling | Material security/privacy risks accepted or mitigated |
| Test readiness review | Before hardening / launch | Test strategy, critical-path coverage, environment readiness | Verification plan can prove fitness for release |
| Release readiness review | Pre-launch | Rollout plan, rollback plan, support plan, communications | Team can launch, monitor, and reverse safely |
| Incident review / postmortem | After Sev events | Root cause, corrective actions, ownership | Learning converted into tracked work |
| Service review | Recurring after launch | SLOs, incidents, usage, support issues, cost | Product and operations learn from production together |

### 8.3 Minimum decision-log policy

Record at least:
- strategic decisions,
- scope changes,
- architecture tradeoffs,
- contract-breaking or versioning decisions,
- security/privacy exceptions,
- launch/rollback decisions,
- AI model or prompt policy changes.

For each decision record:
- context,
- decision,
- alternatives considered,
- consequences,
- owner,
- review date.

## 9. Recommended master planning document structure

The simplest durable approach is one master document with linked appendices. Use separate files only when section size or change rate demands it.

| Section | Purpose | Minimum contents |
|---|---|---|
| 1. Executive summary | Align leaders fast | Problem, solution thesis, scope, key risks, target outcome |
| 2. Business and portfolio context | Justify the investment | Business case, market/portfolio context, success metrics, constraints |
| 3. Stakeholders and users | Define who matters | User roles, admins, buyers, approvers, external dependencies |
| 4. Current-state workflow and pain | Explain why change is needed | Workflow map, pain points, baseline metrics, manual workarounds |
| 5. Scope and roadmap | Bound the effort | In scope, out of scope, phases, dependencies, assumptions |
| 6. Functional requirements | Define behavior | Feature list, user stories/use cases, business rules, edge cases |
| 7. Acceptance criteria | Define verifiable completion | Testable criteria, examples, failure behavior, invariants |
| 8. Non-functional requirements | Define quality targets | Performance, reliability, security, accessibility, localization, cost, supportability |
| 9. UX/UI/content design | Define the experience | IA, flows, states, components, tokens, content rules, accessibility notes |
| 10. Domain and data model | Define truth and semantics | Entities, relationships, schemas, events, analytics taxonomy, lineage |
| 11. Architecture and technical strategy | Define system shape | C4 diagrams, ADRs, runtime model, stack, major tradeoffs |
| 12. Interfaces and contracts | Define boundaries | OpenAPI/AsyncAPI, route maps, event schemas, versioning, auth, error model |
| 13. Engineering standards and delivery model | Define how build happens | Repo structure, conventions, CI/CD, environments, branching, feature flags |
| 14. Security, privacy, and compliance | Define trust model | Threat model, controls, data classification, retention, audit, supply chain |
| 15. Test and verification strategy | Define proof | Test levels, environments, test data, quality gates, release criteria |
| 16. Operations and support model | Define life after launch | SLOs, telemetry, dashboards, runbooks, support workflows, incident model |
| 17. Team operating model and governance | Define who decides and when | Roles, RACI, forums, review gates, decision log policy |
| 18. Risks, assumptions, and open questions | Expose uncertainty | Risk register, unresolved decisions, owners, due dates |
| 19. Launch, migration, and rollback plan | Define safe change | Rollout strategy, communications, rollback, migration choreography |
| 20. Deprecation and retirement plan | Define end of life | Compatibility windows, archive/deletion rules, sunset communications |
| Appendices | Keep detail accessible | Glossary, source links, diagrams, vendor list, control mappings, sample payloads |

## 10. Completion checklist for a real project

Before calling a project "well specified," verify that:

- The problem and business outcome are explicit.
- Users, operators, and approvers are identified.
- Scope boundaries are written down.
- Acceptance criteria and non-functional requirements exist.
- Architecture decisions are documented with tradeoffs.
- API/event/UI contracts are specified and testable.
- Data semantics, lineage, retention, and migration are defined.
- Security/privacy/compliance requirements are mapped to controls.
- Quality strategy covers functional and non-functional verification.
- Release, rollback, and support plans exist before launch.
- Telemetry, dashboards, and incident ownership are ready before launch.
- Documentation ownership is assigned.
- Governance forums and decision rights are known.
- Deprecation and retirement are not left as "future work."
- If AI is involved, evals, permissions, and human review rules exist.

## 11. Source set that informed this blueprint

The following standards and frameworks were verified against official pages on 2026-04-02 and informed this blueprint:

- **[DORA 2025]** Google Cloud, *2025 DORA State of AI Assisted Software Development*. https://cloud.google.com/devops/state-of-devops
- **[NIST SSDF]** NIST SP 800-218, *Secure Software Development Framework (SSDF) Version 1.1*. Final page: https://csrc.nist.gov/pubs/sp/800/218/final
- **[NIST AI RMF]** NIST, *AI Risk Management Framework*. https://www.nist.gov/itl/ai-risk-management-framework
- **[NIST Privacy Framework]** NIST, *Privacy Framework*. https://www.nist.gov/privacy-framework
- **[OWASP SAMM]** OWASP, *Software Assurance Maturity Model*. https://owaspsamm.org/model/
- **[OWASP ASVS]** OWASP, *Application Security Verification Standard*. https://owasp.org/www-project-application-security-verification-standard/
- **[WCAG]** W3C WAI, *WCAG 2 Overview*. https://www.w3.org/WAI/standards-guidelines/wcag/
- **[OpenAPI]** OpenAPI Initiative, *OpenAPI Specification v3.2.0*. https://spec.openapis.org/oas/latest.html
- **[AsyncAPI]** AsyncAPI Initiative, *AsyncAPI Specification 3.1.0*. https://www.asyncapi.com/docs/reference/specification/latest
- **[C4]** Simon Brown, *C4 model*. https://c4model.com/
- **[RFC 2119]** IETF, *Key words for use in RFCs to Indicate Requirement Levels* (1997). https://www.rfc-editor.org/rfc/rfc2119
- **[ISO 27001]** ISO, *ISO/IEC 27001:2022 - Information security management systems*. https://www.iso.org/standard/27001
- **[SLSA]** SLSA, *Supply-chain Levels for Software Artifacts*. https://slsa.dev/
- **[NTIA SBOM]** NTIA, *Software Bill of Materials*. https://www.ntia.gov/SBOM
- **[SPDX]** SPDX, *Specifications*. https://spdx.dev/specifications/
- **[CycloneDX]** CycloneDX, *Specification Overview*. https://cyclonedx.org/specification/overview/

## 12. Practical guidance for writing specs

- Use **MUST / SHOULD / MAY** consistently for normative language in requirements and contracts [RFC 2119].
- Keep strategy, requirements, architecture, contracts, and operations linked; isolated documents decay fast.
- Split documents only when ownership or update cadence clearly differs.
- If a section has no owner, assume it will drift.
- If an artifact has no downstream consumer, question why it exists.
- If a launch plan lacks rollback, it is not a launch plan.
- If an AI feature lacks evals and escalation rules, it is not production-ready.

---

## 13. Game-development artifact extensions (cross-section)

The `game-dev` profile family adds 23 artifact kinds across the existing 16 sections. Engine sub-modes (`game-dev-unity` / `-unreal` / `-godot` / `-web` / `-custom`) layer on engine-specific artifacts. Console / live-service / online / voice posture flags are detected from project state and gate additional rubrics + missability checks.

**§4.1 Strategy** — adds `one_pager` (concept hook, audience, comp set).

**§4.3 Scope and requirements** — adds `gdd` (game design doc — umbrella for mechanics + systems), `vertical_slice_scope` (what's in the slice and why), `mechanic_spec` (per-feature brief: verbs / inputs / outputs / failure modes).

**§4.4 Experience design** — adds `art_bible`, `sound_design_doc`, `narrative_bible`, `dialogue_tree_spec`, `level_greybox`, `encounter_design_doc`, `accessibility_plan`, `localization_plan`. These mirror the mature shape of disciplined studios (Whimsy / GameDesignSkills / Algoryte / Savchenko canonical structure).

**§4.5 Domain model and data** — adds `economy_spreadsheet` (currencies / sources / sinks / gacha math / drop rates), `progression_curve` (XP curves, scaling), `loot_table` (weighted droppables), `balance_matrix` (class/role vs role with test methodology), `telemetry_event_taxonomy` (D1/D7/D30 events, dimensions, retention).

**§4.6 Architecture** — adds `tech_design_doc` (engine / platforms / perf targets) plus engine-specific: `addressables_strategy` (Unity), `asmdef_layout` (Unity), `gas_design` (Unreal Gameplay Ability System), `world_partition_plan` (Unreal open-world), `scene_topology` (Godot scene tree).

**§4.10 Quality engineering** — adds `performance_profile` (capture from Unity Profiler / Unreal Insights / RenderDoc / PIX / Razor matched to the per-platform-tier `game-perf-budget@1` rubric).

**§4.11 Delivery and release** — adds `build_release_plan` (milestones, day-1 patch, cert dates), `cert_submission_packet` (TRC / XR / Lotcheck checklist evidence — non-authoritative; studios use their NDA-bound docs as source of truth), `liveops_season_plan` (events, store, A/B test plan).

**§4.13 Documentation** — adds `patch_notes` (release artifact for community), `post_mortem` (canonical Gamasutra format).

**Standards rubrics pinned by the `game-dev` profile family**:

| Rubric id | Source |
|---|---|
| `game-accessibility-guidelines@1` | gameaccessibilityguidelines.com (GAG Basic / Intermediate / Advanced × Motor / Cognitive / Vision / Hearing / Speech / General) |
| `xbox-accessibility-guidelines@1` | learn.microsoft.com/en-us/gaming/accessibility (XAG-101..125) |
| `console-cert-checklist@1` | Aggregator-derived (iXie / SandVox / Kudos QA / N-iX / public Microsoft XR-017). Banner: studios MUST use their NDA-bound TRC/XR/Lotcheck docs as authoritative source. |
| `iarc-rating-questionnaire@1` | globalratings.com (IARC → ESRB / PEGI / USK / ClassInd / ACB) |
| `coppa-2.0-data-flows@1` | FTC COPPA 2.0 (effective 2025-06; compliance 2026-04-22) + GDPR-K |
| `loot-box-jurisdiction@1` | Belgium ban / Netherlands quasi-ban / 2025 Antwerp ruling / EU Digital Fairness Act draft / China drop-rate disclosure / Apple iOS guidelines |
| `steam-ai-disclosure@1` | Steam Jan-2026 rewrite: consumed-by-player vs efficiency-only |
| `sag-aftra-ai-rider@1` | SAG-AFTRA 2025 Interactive Media Agreement (per-replica consent, 300-line session-fee, suspension during strike) |
| `game-perf-budget@1` | Per-platform-tier budgets (PS5/XSX/Switch/Switch 2/Steam Deck/Mobile A/B/C/VR Quest 3) |
| `igda-gasig@1` | IGDA Game Accessibility SIG guidelines |

**Profile-derived posture flags**: `console-cert` (PS5/XSX/Switch in build config), `live-service` (gacha/season-pass/loot-box keywords), `online` (multiplayer/rollback/server-auth keywords or netcode middleware), `voice` (voice-acting/TTS/AI-voice keywords). Each flag enables the relevant missability-check bucket; voice gate is **warn-only** (never hard-fails the run).

---

**Bottom line**: a complete software blueprint is not just a stack of specs. It is a coordinated operating system for product value, implementation quality, trust, delivery, and change over time.
