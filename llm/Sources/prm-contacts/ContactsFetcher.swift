import Contacts
import Foundation

enum ContactsError: LocalizedError, Equatable {
    case accessDenied
    case accessRestricted
    case unknownAuthStatus(String)
    case fetchFailed(String)

    var errorDescription: String? {
        switch self {
        case .accessDenied:
            return "Contacts access denied. Grant access in System Settings > Privacy & Security > Contacts"
        case .accessRestricted:
            return "Contacts access restricted by system policy"
        case .unknownAuthStatus(let status):
            return "Unknown contacts authorization status: \(status)"
        case .fetchFailed(let message):
            return "Failed to fetch contacts: \(message)"
        }
    }
}

struct ContactsFetcher {
    private let store = CNContactStore()

    /// Keys to fetch - excludes CNContactNoteKey which requires
    /// com.apple.developer.contacts.notes entitlement (Apple approval required)
    private let keysToFetch: [CNKeyDescriptor] = [
        CNContactGivenNameKey as CNKeyDescriptor,
        CNContactFamilyNameKey as CNKeyDescriptor,
        CNContactOrganizationNameKey as CNKeyDescriptor,
        CNContactEmailAddressesKey as CNKeyDescriptor,
        CNContactPhoneNumbersKey as CNKeyDescriptor,
        CNContactIdentifierKey as CNKeyDescriptor,
    ]

    func requestAccessIfNeeded() async throws {
        let status = CNContactStore.authorizationStatus(for: .contacts)

        switch status {
        case .authorized, .limited:
            return  // Good to proceed
        case .notDetermined:
            let granted = try await store.requestAccess(for: .contacts)
            if !granted {
                throw ContactsError.accessDenied
            }
        case .denied:
            throw ContactsError.accessDenied
        case .restricted:
            throw ContactsError.accessRestricted
        @unknown default:
            // Log warning for future-proofing - new status values added by Apple
            throw ContactsError.unknownAuthStatus("rawValue=\(status.rawValue)")
        }
    }

    func fetchAllContacts(includeAll: Bool = false) throws -> [Contact] {
        var contacts: [Contact] = []
        let request = CNContactFetchRequest(keysToFetch: keysToFetch)

        try store.enumerateContacts(with: request) { cnContact, _ in
            let emails = cnContact.emailAddresses.map { $0.value as String }
            let phones = cnContact.phoneNumbers.map { $0.value.stringValue }

            // Skip contacts without handles unless includeAll is true
            if !includeAll && emails.isEmpty && phones.isEmpty {
                return
            }

            let fullName = [cnContact.givenName, cnContact.familyName]
                .filter { !$0.isEmpty }
                .joined(separator: " ")

            // Use full name, fall back to organization, then to "Unknown"
            let name = fullName.isEmpty
                ? (cnContact.organizationName.isEmpty ? "Unknown" : cnContact.organizationName)
                : fullName

            contacts.append(
                Contact(
                    name: name,
                    emails: emails,
                    phones: phones,
                    company: cnContact.organizationName.isEmpty ? nil : cnContact.organizationName
                ))
        }

        return contacts
    }
}
