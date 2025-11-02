using EatNow.UsageApi.Models;
using EatNow.UsageApi.Services;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Caching.Memory;

namespace EatNow.UsageApi.Controllers;

[ApiController]
[Route("stats")]
public class StatsController : ControllerBase
{
    private readonly FirestoreService _fs;
    private readonly IMemoryCache _cache;
    public StatsController(FirestoreService fs, IMemoryCache cache) { _fs = fs; _cache = cache; }

    [HttpGet("today")]
    public async Task<ActionResult<TodayUsageDto>> GetToday([FromQuery] string dateId = "")
    {
        var key = $"today:{dateId}";
        if (_cache.TryGetValue(key, out TodayUsageDto dto)) return Ok(dto);

        // 預設今日 Taipei 時區
        if (string.IsNullOrWhiteSpace(dateId))
        {
            var now = TimeZoneInfo.ConvertTime(DateTime.UtcNow, TimeZoneInfo.FindSystemTimeZoneById("Asia/Taipei"));
            dateId = now.ToString("yyyyMMdd");
        }
        var doc = await _fs.GetDoc("usage_maps_daily", dateId);
        var counters = doc.TryGetValue("counters", out var o) && o is Dictionary<string, object> d ? d : new();

        static long L(Dictionary<string, object> d, string k)
            => d.TryGetValue(k, out var v) && v is IConvertible ? Convert.ToInt64(v) : 0L;

        dto = new TodayUsageDto(
            dateId,
            L(counters,"messages_total"),
            L(counters,"messages_text"),
            L(counters,"messages_image"),
            L(counters,"messages_flex_bubble"),
            L(counters,"messages_flex_carousel"),
            L(counters,"push_total"),
            L(counters,"push_text"),
            L(counters,"push_image"),
            L(counters,"push_flex_bubble"),
            L(counters,"push_flex_carousel")
        );

        _cache.Set(key, dto, TimeSpan.FromSeconds(5));
        return Ok(dto);
    }
}
