namespace EatNow.UsageApi.Models;

public record TodayUsageDto(
    string dateId,
    long messages_total,
    long messages_text,
    long messages_image,
    long messages_flex_bubble,
    long messages_flex_carousel,
    long push_total,
    long push_text,
    long push_image,
    long push_flex_bubble,
    long push_flex_carousel
);
