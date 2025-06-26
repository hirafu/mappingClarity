# Project Clarity: AI-Powered Data Classification Platform

## 1. Project Overview

Project Clarity is a secure, scalable, multi-tenant web application designed to automate the classification of financial and operational data. The platform leverages a sophisticated AI-powered pipeline to ingest user-uploaded data (e.g., accounting records, invoices), classify each row against both standardized and custom schemas, and present the results in a real-time web interface for human review and verification.

The core goal is to transform the time-consuming manual process of data categorization into an efficient, intelligent, and self-improving automated workflow. The system is built to handle large datasets and provides tenant administrators with powerful tools to configure their own data processing pipelines, manage users, and track changes through a comprehensive audit trail.

---

## 2. Architecture & Technology Stack

The application is built on a modern, serverless architecture using Google Cloud Platform (GCP) services, chosen specifically for scalability, security, and integration.

| Component                 | Technology                               | Justification                                                                                                                                                                             |
| ------------------------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Frontend Web Apps** | **Firebase Hosting (Multi-Site)** | Provides global CDN delivery, automatic SSL, and atomic deployments. The multi-site feature securely isolates the main user-facing app from the internal Super Admin portal.                |
| **User & Tenant Mgmt.** | **Firebase Authentication & Cloud Functions** | Firebase Auth provides secure user management (email/password & Google SSO). Secure HTTP Cloud Functions (`createTenant`, `inviteUser`, `manageUser`) handle administrative actions.       |
| **Data Ingestion** | **Cloud Storage & Eventarc** | GCS provides a scalable and durable location for file uploads. Eventarc provides a robust, decoupled eventing system to trigger backend processes when a new file arrives.                   |
| **Orchestration** | **Cloud Workflows** | Acts as the central "brain" of the processing pipeline. It's triggered by Eventarc and reliably orchestrates the execution of the main Cloud Run Job, handling retries and error logging. |
| **Heavy Data Processing** | **Cloud Run Jobs** | Chosen over Cloud Functions to handle potentially very large files. It allows for long timeouts (60+ minutes) and high memory allocation, making it ideal for streaming and batch processing. |
| **Application Database** | **Cloud Firestore** | Serves as the user-facing "system of record". Its real-time capabilities power the interactive web UI, and its flexible data model is perfect for storing job data and audit trails.  |
| **AI & Classification** | **Vertex AI (Gemini)** | Forms the core intelligence. **Gemini** provides the contextual reasoning for complex classifications. |

---

## 3. Data Flow & Processing Pipeline

The system uses a sophisticated "classification cascade" designed to provide the most accurate result using the cheapest and fastest method possible.

1. **Upload:** An authenticated user selects a pre-configured `Pipeline` and uploads a file (`.csv` only at the moment) via the web app. The `uploadFile` Cloud Function securely places the file in a tenant-specific GCS path: `uploads/{tenantId}/{pipelineId}/{jobId}/{filename}`.

2. **Trigger:** An **Eventarc** trigger detects the new file and executes the main **Cloud Workflow**.

3. **Orchestration:** The **Cloud Workflow** starts. It extracts the file details and executes the main `process-csv-job` **Cloud Run Job**, passing the bucket and file path as arguments.

4. **Processing Job (`process-csv-job`):**
   a. The job starts and loads the tenant's specific `pipeline` configuration from Firestore.
   b. It begins **streaming** the large source file from GCS, never loading the entire file into memory.
   c. For each row in the stream, **Augmented Generation (Gemini):** The row is then put into Gemini that understand the row against the definitions and classifies it.
   d. The classification result (including reasoning and confidence) is written to a `rows` subcollection in Firestore under the current `job` document: `/tenants/{tenantId}/jobs/{jobId}/rows/{rowIndex}`.

5. **Human Review:** The web application, which has a real-time listener attached to the Firestore collection, automatically displays the new results on the user's review page as they are created.

---

## 4. Features Developed to Date

### Core Platform

* **Multi-Tenant Architecture:** All data is securely isolated by a `tenantId`, enforced by Firestore Security Rules.

* **Role-Based Access Control (RBAC):** A robust roles system is in place:

  * **Super Admin:** Manages tenants via a separate, secure web portal.

  * **Tenant Admin:** Manages users, roles, and data pipelines for their specific tenant.

  * **Uploader:** Can upload data and review/edit classification results.

  * **Viewer:** Can only view job history and results.

* **User Management & Invitations:** Tenant admins can invite, disable, delete, and change roles for users within their tenant. Invitations are sent via email.

* **Scalable Batch Processing:** The backend uses Cloud Run Jobs to process files of any size without timing out, streaming data to keep memory usage low.

### Intelligent Features

* **Dynamic Data Pipelines:** Tenant admins can create and configure their own data processing pipelines, defining which columns to use for AI analysis and which fields to classify.

* **Human-in-the-Loop Feedback:** All manual edits made by users are recorded in a detailed audit trail.

### User Experience

* **Real-Time Review UI:** The web application updates in real-time as the backend processes data, with no need for a page refresh.

* **Job History & Status:** Users can view a complete history of all past jobs and their current status (e.g., "Processing", "Completed").

* **Audit Trail:** Users can view a complete history of all manual edits for any given row, providing full transparency.
