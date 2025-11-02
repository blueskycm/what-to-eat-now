using Google.Cloud.Firestore;

namespace EatNow.UsageApi.Services;

public class FirestoreService
{
    private readonly FirestoreDb _db;
    public FirestoreService(IConfiguration cfg)
    {
        var projectId = Environment.GetEnvironmentVariable("FIREBASE_PROJECT_ID")
                        ?? cfg["FIREBASE_PROJECT_ID"]
                        ?? throw new Exception("FIREBASE_PROJECT_ID not set.");
        _db = FirestoreDb.Create(projectId);
    }

    public async Task<Dictionary<string, object>> GetDoc(string coll, string doc)
    {
        var snap = await _db.Collection(coll).Document(doc).GetSnapshotAsync();
        return snap.Exists ? snap.ToDictionary() : new();
    }
}
